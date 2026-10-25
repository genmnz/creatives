package io.github.genmnz.warden;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.InetAddresses;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.telephony.SubscriptionManager;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.DatagramChannel;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The one long-running piece. It does three jobs and sleeps otherwise:
 *  1. DNS filter: a local VPN that routes ONLY DNS (a fake resolver address,
 *     plus well-known public DNS IPs) into this app. All other traffic goes
 *     straight out untouched, so there is no per-packet cost on downloads,
 *     video, etc. Blocked names get 0.0.0.0; the rest go to your network's
 *     own DNS server, results cached.
 *  2. Settings lock (Guard), re-checked whenever the SIM/carrier changes.
 *  3. Location spoofing (Spoofer).
 * No polling, no wakelocks, no timers while idle: two threads blocked in read()/select().
 */
public final class Engine extends VpnService {
    static final String ACTION_SYNC = "sync", ACTION_STOP = "stop";
    private static final String DNS4 = "10.111.222.1", ADDR4 = "10.111.222.2", ADDR6 = "fd57:a7de::2";
    /** Public resolvers apps hardcode to dodge the system DNS. Caught and answered by us. */
    private static final String[] HARDCODED = {
            "8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112",
            "208.67.222.222", "208.67.220.220", "94.140.14.14", "94.140.15.15", "76.76.2.0", "76.76.10.0",
            "2001:4860:4860::8888", "2001:4860:4860::8844", "2606:4700:4700::1111", "2606:4700:4700::1001",
            "2620:fe::fe", "2620:fe::9",
    };
    private static final int MTU = 16384;
    private static final long UPSTREAM_TIMEOUT_MS = 4000;

    static volatile Engine running;

    private Handler main;
    private ParcelFileDescriptor tun;
    private FileOutputStream tunOut;
    private Thread reader, forwarder;
    private volatile Selector selector;
    private final ConcurrentLinkedQueue<Pending> queue = new ConcurrentLinkedQueue<>();

    volatile Blocklist list;
    private volatile InetAddress[] upstream = new InetAddress[0];
    private volatile int upIdx;
    private final Cache cache = new Cache();
    final Log log = new Log();
    final AtomicLong queries = new AtomicLong(), blocked = new AtomicLong(), cached = new AtomicLong();
    volatile String warning = "";
    volatile String upstreamText = "";

    Guard guard;
    Spoofer spoofer;
    private ConnectivityManager.NetworkCallback netCb;
    /** Last real (non-VPN) network's properties, from the default-network callback. */
    private LinkProperties netLp;
    private Network netNow;
    private SubscriptionManager.OnSubscriptionsChangedListener simCb;
    private BroadcastReceiver simRx;

    // ---------------------------------------------------------------- lifecycle

    /** Starts, reconfigures or stops the engine to match the saved settings. */
    static void sync(Context c) {
        SharedPreferences p = Store.prefs(c);
        boolean want = p.getBoolean("dns_on", false) || p.getBoolean("spoof_on", false) || !Guard.readLocks(c).isEmpty();
        Intent i = new Intent(c, Engine.class).setAction(want ? ACTION_SYNC : ACTION_STOP);
        if (!want && running == null) return;
        try {
            if (want) c.startForegroundService(i); else c.startService(i);
        } catch (RuntimeException ignored) {
            // background start refused; the always-on VPN or next app open brings it back
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        main = new Handler(Looper.getMainLooper());
        guard = new Guard(this, main);
        spoofer = new Spoofer(this, main);
        running = this;
        watchNetwork();
        watchSim();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        String action = intent == null ? ACTION_SYNC : intent.getAction(); // null intent: restarted by system / always-on
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }
        if (SERVICE_INTERFACE.equals(action)) {
            // started by Always-on VPN (boot, or switched on in system settings): filter on
            Store.prefs(this).edit().putBoolean("dns_on", true).apply();
        }
        apply();
        return START_STICKY;
    }

    private void apply() {
        SharedPreferences p = Store.prefs(this);
        guard.start();
        if (p.getBoolean("spoof_on", false)) {
            spoofer.start(Double.parseDouble(p.getString("lat", "0")), Double.parseDouble(p.getString("lon", "0")));
        } else {
            spoofer.stop();
        }
        boolean dns = p.getBoolean("dns_on", false) && prepare(this) == null;
        if (dns) startDns(); else stopDns();
        if (!dns && !spoofer.active() && Guard.readLocks(this).isEmpty()) stopEverything();
    }

    private void stopEverything() {
        stopDns();
        spoofer.stop();
        guard.stop();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onRevoke() {
        // another VPN took over, or the user turned us off in system settings
        Store.prefs(this).edit().putBoolean("dns_on", false).apply();
        stopDns();
        apply();
    }

    @Override public void onDestroy() {
        stopDns();
        spoofer.stop();
        guard.stop();
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (netCb != null) try { cm.unregisterNetworkCallback(netCb); } catch (RuntimeException ignored) { }
        if (simCb != null) getSystemService(SubscriptionManager.class).removeOnSubscriptionsChangedListener(simCb);
        if (simRx != null) unregisterReceiver(simRx);
        if (running == this) running = null;
        super.onDestroy();
    }

    /** adb shell dumpsys activity service io.github.genmnz.warden/.Engine */
    @Override protected void dump(java.io.FileDescriptor fd, java.io.PrintWriter w, String[] args) {
        w.println("dns running: " + dnsRunning() + ", upstream: " + upstreamText + ", warning: " + warning);
        w.println("network: " + netLp);
        w.println("queries " + queries + ", blocked " + blocked + ", cached " + cached + ", in flight " + queue.size());
        w.println("rules: " + (list == null ? 0 : list.block.length) + ", locks: " + Guard.readLocks(this));
        w.println("guard reverts " + guard.reverts + " last " + guard.lastEvent + " err " + guard.lastError);
        w.println("spoof active " + spoofer.active() + " err " + Spoofer.error);
    }

    @Override public void onTrimMemory(int level) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) cache.clear();
    }

    private void goForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel("w", "Running", NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, "w")
                .setSmallIcon(R.drawable.ic_stat).setContentTitle("Melad is guarding")
                .setContentIntent(open).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
    }

    // ---------------------------------------------------------------- network + SIM

    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        netCb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { pickNetwork(); }
            @Override public void onLost(Network n) { pickNetwork(); }
            @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities nc) { pickNetwork(); }
            @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { pickNetwork(); }
        };
        // A default NetworkRequest excludes VPNs, so this sees only real Wi-Fi/mobile/ethernet networks.
        // (The "default network" callback can report our own VPN, even though we exclude ourselves from it.)
        cm.registerNetworkCallback(new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), netCb, main);
    }

    /** Chooses the network Android itself would use: validated first, Wi-Fi/ethernet before mobile. */
    private void pickNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        Network best = null;
        int bestScore = -1;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc == null || nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    || !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
            int score = (nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ? 2 : 0)
                    + (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? 0 : 1);
            if (score > bestScore) { best = n; bestScore = score; }
        }
        LinkProperties lp = best == null ? null : cm.getLinkProperties(best);
        if (best != null && !best.equals(netNow)) {
            netNow = best;
            if (tun != null) setUnderlyingNetworks(new Network[]{best}); // correct metered/roaming status for apps
        }
        String before = upstreamText;
        netLp = lp;
        setUpstream(lp);
        if (!upstreamText.equals(before)) guard.burst(); // new network/SIM: carrier settings may follow
        maybeUpdateLists(best, cm);
    }

    private volatile boolean updating;

    /** Refreshes blocklists about once a day, on unmetered (Wi-Fi) networks only, if the user allows it. */
    private void maybeUpdateLists(Network best, ConnectivityManager cm) {
        if (updating || best == null || !dnsRunning()) return;
        if (!Store.prefs(this).getBoolean("auto_update", true) || !Updater.due(this)) return;
        NetworkCapabilities nc = cm.getNetworkCapabilities(best);
        if (nc == null || !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                || !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return;
        updating = true;
        new Thread(() -> {
            try { Updater.updateAll(this, null); } catch (RuntimeException ignored) { } finally { updating = false; }
        }, "melad-lists").start();
    }

    private void setUpstream(LinkProperties lp) {
        String custom = Store.prefs(this).getString("upstream", "").trim();
        List<InetAddress> list = new ArrayList<>();
        if (!custom.isEmpty()) {
            for (String s : custom.split("[,\\s]+")) {
                try { list.add(InetAddresses.parseNumericAddress(s)); } catch (IllegalArgumentException ignored) { }
            }
        } else if (lp != null) {
            for (InetAddress a : lp.getDnsServers()) if (!a.getHostAddress().equals(DNS4)) list.add(a);
        }
        // IPv4 servers first, IPv6 as fallback
        list.sort((a, b) -> Boolean.compare(!(a instanceof Inet4Address), !(b instanceof Inet4Address)));
        StringBuilder sb = new StringBuilder();
        for (InetAddress a : list) sb.append(sb.length() > 0 ? ", " : "").append(a.getHostAddress());
        String text = sb.length() > 0 ? sb.toString() : "none";
        if (!text.equals(upstreamText)) {
            upstream = list.toArray(new InetAddress[0]);
            upIdx = 0;
            upstreamText = text;
            cache.clear(); // answers can differ per network
        }
        warning = lp != null && lp.getPrivateDnsServerName() != null
                ? "Private DNS is set to a hostname (" + lp.getPrivateDnsServerName() + "). Android sends DNS there "
                + "directly, skipping Melad. Set Settings → Connections → More → Private DNS to Off."
                : "";
    }

    private void watchSim() {
        SubscriptionManager sm = getSystemService(SubscriptionManager.class);
        simCb = new SubscriptionManager.OnSubscriptionsChangedListener() {
            @Override public void onSubscriptionsChanged() { guard.burst(); }
        };
        try { sm.addOnSubscriptionsChangedListener(simCb); } catch (RuntimeException e) { simCb = null; }
        simRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { guard.burst(); }
        };
        IntentFilter f = new IntentFilter("android.intent.action.SIM_STATE_CHANGED");
        f.addAction(Intent.ACTION_TIMEZONE_CHANGED);
        f.addAction("android.intent.action.SERVICE_STATE");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(simRx, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(simRx, f);
    }

    // ---------------------------------------------------------------- DNS filter

    void reloadLists() {
        try { list = Store.load(this); } catch (IOException ignored) { }
        cache.clear();
    }

    private synchronized void startDns() {
        if (tun != null) return;
        reloadLists();
        boolean catchHardcoded = Store.prefs(this).getBoolean("catch_hardcoded", true);
        Builder b = new Builder()
                .setSession("Melad DNS filter")
                .setMtu(MTU)
                .setBlocking(true)
                .addAddress(ADDR4, 32)
                .addRoute(DNS4, 32)
                .addDnsServer(DNS4);
        if (catchHardcoded) {
            b.addAddress(ADDR6, 128);
            for (String ip : HARDCODED) b.addRoute(ip, ip.indexOf(':') >= 0 ? 128 : 32);
        }
        try {
            b.addDisallowedApplication(getPackageName());
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        b.setMetered(false);
        try {
            tun = b.establish();
        } catch (RuntimeException e) {
            warning = "Could not start the DNS filter: " + e.getMessage();
            return;
        }
        if (tun == null) return; // permission revoked
        netNow = null;
        pickNetwork();
        tunOut = new FileOutputStream(tun.getFileDescriptor());
        try {
            selector = Selector.open();
        } catch (IOException e) {
            stopDns();
            return;
        }
        final FileInputStream in = new FileInputStream(tun.getFileDescriptor());
        reader = new Thread(() -> readLoop(in), "warden-tun");
        forwarder = new Thread(this::forwardLoop, "warden-dns");
        reader.start();
        forwarder.start();
    }

    private synchronized void stopDns() {
        if (reader != null) reader.interrupt();
        if (forwarder != null) forwarder.interrupt();
        Selector s = selector;
        selector = null;
        if (s != null) {
            for (SelectionKey k : s.keys()) closeQuietly(k);
            try { s.close(); } catch (IOException ignored) { }
        }
        if (tun != null) try { tun.close(); } catch (IOException ignored) { }
        tun = null;
        tunOut = null;
        reader = forwarder = null;
        queue.clear();
    }

    boolean dnsRunning() { return tun != null; }

    /** Android's "Always-on VPN" for Melad. Only meaningful while the filter runs. */
    boolean alwaysOn() { try { return isAlwaysOn(); } catch (RuntimeException e) { return false; } }

    /** Android's "Block connections without VPN". Melad routes only DNS, so this cuts all other traffic. */
    boolean lockdown() { try { return isLockdownEnabled(); } catch (RuntimeException e) { return false; } }

    private void write(byte[] b, int len) {
        FileOutputStream o = tunOut;
        if (o == null) return;
        synchronized (this) {
            try { o.write(b, 0, len); } catch (IOException ignored) { }
        }
    }

    private void readLoop(FileInputStream in) {
        byte[] buf = new byte[MTU];
        byte[] out = new byte[MTU + 128];
        byte[] dns = new byte[MTU];
        Packets.Question q = new Packets.Question();
        while (!Thread.currentThread().isInterrupted()) {
            int n;
            try {
                n = in.read(buf);
            } catch (IOException e) {
                break; // tun closed
            }
            if (n <= 0) continue;
            int l4 = Packets.l4Offset(buf, n);
            if (l4 < 0) continue;
            int proto = Packets.proto(buf);
            if (proto == Packets.TCP) {
                int m = Packets.tcpReset(buf, n, l4, out);
                if (m > 0) write(out, m);
                continue;
            }
            if (proto != Packets.UDP || n < l4 + 8 || Packets.u16(buf, l4 + 2) != 53) continue;
            int off = l4 + 8, len = n - off;
            if (!Packets.parseQuestion(buf, off, len, q)) continue;
            queries.incrementAndGet();
            String key = q.key();
            Blocklist bl = list;
            if (bl != null && bl.blocked(q.name, q.nameLen)) {
                blocked.incrementAndGet();
                log.add(key, true);
                int dl = Packets.blockedAnswer(buf, off, q, dns);
                write(out, Packets.udpReply(buf, l4, dns, dl, out));
                continue;
            }
            log.add(key, false);
            byte[] hit = cache.get(key);
            if (hit != null) {
                cached.incrementAndGet();
                System.arraycopy(hit, 0, dns, 0, hit.length);
                dns[0] = buf[off];
                dns[1] = buf[off + 1];
                write(out, Packets.udpReply(buf, l4, dns, hit.length, out));
                continue;
            }
            if (upstream.length == 0) {
                int dl = Packets.servfail(buf, off, q, dns);
                write(out, Packets.udpReply(buf, l4, dns, dl, out));
                continue;
            }
            queue.add(new Pending(java.util.Arrays.copyOf(buf, n), l4, key));
            Selector s = selector;
            if (s != null) s.wakeup();
        }
    }

    private static final class Pending {
        final byte[] pkt;
        final int l4;
        final String key;
        long started;

        Pending(byte[] pkt, int l4, String key) { this.pkt = pkt; this.l4 = l4; this.key = key; }
    }

    private void forwardLoop() {
        ByteBuffer rb = ByteBuffer.allocate(MTU - 128);
        byte[] out = new byte[MTU + 128];
        while (!Thread.currentThread().isInterrupted()) {
            Selector s = selector;
            if (s == null) return;
            try {
                // blocks forever when nothing is in flight: zero CPU while idle
                if (s.keys().isEmpty() && queue.isEmpty()) s.select();
                else s.select(1000);
            } catch (IOException | java.nio.channels.ClosedSelectorException e) {
                return;
            }
            try {
                forwardOnce(s, rb, out);
            } catch (java.nio.channels.ClosedSelectorException e) {
                return; // stopDns closed it
            }
        }
    }

    private void forwardOnce(Selector s, ByteBuffer rb, byte[] out) {
        for (Pending p; (p = queue.poll()) != null; ) send(s, p);
        Iterator<SelectionKey> it = s.selectedKeys().iterator();
        while (it.hasNext()) {
            SelectionKey k = it.next();
            it.remove();
            receive(k, rb, out);
        }
        long now = SystemClock.elapsedRealtime();
        for (SelectionKey k : s.keys()) {
            Pending p = (Pending) k.attachment();
            if (p != null && now - p.started > UPSTREAM_TIMEOUT_MS) {
                closeQuietly(k);
                upIdx++; // try the next server for following queries
            }
        }
    }

    private void send(Selector s, Pending p) {
        InetAddress[] ups = upstream;
        if (ups.length == 0) return;
        InetAddress server = ups[Math.floorMod(upIdx, ups.length)];
        DatagramChannel ch = null;
        try {
            ch = DatagramChannel.open();
            protect(ch.socket());
            ch.configureBlocking(false);
            ch.connect(new InetSocketAddress(server, 53));
            int off = p.l4 + 8;
            ch.write(ByteBuffer.wrap(p.pkt, off, p.pkt.length - off));
            p.started = SystemClock.elapsedRealtime();
            ch.register(s, SelectionKey.OP_READ, p);
        } catch (IOException | RuntimeException e) {
            if (ch != null) try { ch.close(); } catch (IOException ignored) { }
            upIdx++;
        }
    }

    private void receive(SelectionKey k, ByteBuffer rb, byte[] out) {
        Pending p = (Pending) k.attachment();
        DatagramChannel ch = (DatagramChannel) k.channel();
        int n;
        rb.clear();
        try {
            n = ch.read(rb);
        } catch (IOException e) {
            n = -1;
        }
        if (n == 0) return; // spurious wakeup, keep waiting
        closeQuietly(k);
        int off = p.l4 + 8;
        byte[] r = rb.array();
        if (n < 12 || r[0] != p.pkt[off] || r[1] != p.pkt[off + 1]) return;
        int ttl = Packets.cacheTtl(r, n);
        if (ttl > 0) cache.put(p.key, java.util.Arrays.copyOf(r, n), Math.min(ttl, 600));
        write(out, Packets.udpReply(p.pkt, p.l4, r, n, out));
    }

    private static void closeQuietly(SelectionKey k) {
        k.cancel();
        try { k.channel().close(); } catch (IOException ignored) { }
    }

    // ---------------------------------------------------------------- small structures

    /** LRU answer cache. Saves radio wake-ups: most lookups repeat within minutes. */
    private static final class Cache {
        private static final int MAX = 1024;
        private final LinkedHashMap<String, Object[]> m = new LinkedHashMap<String, Object[]>(256, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<String, Object[]> e) { return size() > MAX; }
        };

        synchronized byte[] get(String key) {
            Object[] e = m.get(key);
            if (e == null) return null;
            if (SystemClock.elapsedRealtime() > (Long) e[1]) { m.remove(key); return null; }
            return (byte[]) e[0];
        }

        synchronized void put(String key, byte[] r, int ttlSec) {
            m.put(key, new Object[]{r, SystemClock.elapsedRealtime() + ttlSec * 1000L});
        }

        synchronized void clear() { m.clear(); }
    }

    /** Recently seen names with hit counts, newest last. Feeds the "Recent lookups" screen. */
    static final class Log {
        private static final int MAX = 300;
        private final LinkedHashMap<String, long[]> m = new LinkedHashMap<String, long[]>(512, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<String, long[]> e) { return size() > MAX; }
        };

        synchronized void add(String key, boolean blocked) {
            String name = key.substring(0, key.indexOf('/'));
            long[] e = m.get(name);
            if (e == null) m.put(name, e = new long[2]);
            e[0]++;
            e[1] = blocked ? 1 : 0;
        }

        /** Newest first: {name, count, blocked(0/1)}. */
        synchronized List<Object[]> snapshot() {
            List<Object[]> l = new ArrayList<>(m.size());
            for (Map.Entry<String, long[]> e : m.entrySet()) l.add(0, new Object[]{e.getKey(), e.getValue()[0], e.getValue()[1]});
            return l;
        }
    }
}

package io.github.genmnz.warden;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * One earbud connection, built to cope with ANY pair of buds — recognised or not.
 *
 *  - Passive scan: reads battery from the advertisement (Apple-style / Xiaomi), no pairing.
 *  - On connect it ALWAYS inspects the whole GATT table and tries, in order:
 *      1. JieLi RCSP (service AE00) — live battery + game mode / mic / ANC.
 *      2. A rule you taught it for this exact device (teach it in the Lab).
 *      3. Standard Bluetooth Battery Service (0x180F) — a universal fallback.
 *    plus Device Information (maker / model / firmware) when present.
 *  - Diagnostics: control-response latency (ms), signal (RSSI), connected-for time.
 *  - A raw Lab: subscribe to and write any characteristic, to discover or teach controls.
 *
 * Every GATT action goes through one serial queue (BLE allows one at a time), and every
 * callback is marshalled to the main thread, so the UI never deals with threading.
 */
@SuppressLint("MissingPermission") // EarbudsActivity requests Nearby devices before anything here runs
final class EarbudLink {
    private static UUID uuid(String s) { return UUID.fromString(s); }
    private static UUID base(int id16) { return uuid(String.format(Locale.ROOT, "0000%04x-0000-1000-8000-00805f9b34fb", id16)); }

    static final UUID JL_SERVICE = base(0xAE00);
    private static final UUID JL_WRITE = base(0xAE01), JL_NOTIFY = base(0xAE02);
    private static final UUID CCCD = base(0x2902);
    private static final UUID BATTERY_SVC = base(0x180F), BATTERY_LEVEL = base(0x2A19);
    private static final UUID DEVINFO_SVC = base(0x180A);
    private static final UUID MANUFACTURER = base(0x2A29), MODEL = base(0x2A24), FIRMWARE = base(0x2A26), SERIAL = base(0x2A25);
    private static final int APPLE_COMPANY = 0x004C, XIAOMI_COMPANY = 0x038F;
    private static final UUID XIAOMI_FD2D = base(0xFD2D);

    interface Listener {
        void status(String text);
        void battery(Earbuds.Battery b);
        void controls(Earbuds.JieliInfo info);
        void deviceInfo(String maker, String model, String firmware);
        void inspector(List<String[]> rows); // {serviceName, charName, props, uuid}
        void diagnostics(int latencyMs, int rssi, long uptimeMs);
        void raw(String charUuid, byte[] value);
        void log(String line);
        void classic(ClassicReport r);
    }

    /** Everything Classic Bluetooth tells us — available the moment the buds play music, no LE needed. */
    static final class ClassicReport {
        String name = "", mac = "", type = "", claims = "", vendor = "", verdict = "";
        boolean playing;
        int hfpBattery = -1;
        final List<String[]> services = new ArrayList<>(); // {name, uuid}
        final List<String> vendorChannels = new ArrayList<>(); // uuids usable in the Lab's Classic channel
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothAdapter adapter;
    private Listener listener;

    private BluetoothGatt gatt;
    private String targetMac;
    private String verdict = "";
    private long connectedSince;

    // JieLi RCSP
    private BluetoothGattCharacteristic jlWrite;
    private final Earbuds.RcspReader reader = new Earbuds.RcspReader();
    private boolean authed;
    private int sn = 1;
    private byte[] voiceModeRecord;
    private long cmdSentAt;
    private int latencyMs = -1, rssi = 0;

    // teachable rule
    private Earbuds.CustomRule rule;

    // serial GATT op queue
    private final ArrayDeque<Runnable> ops = new ArrayDeque<>();
    private boolean opBusy;
    private int opToken;

    private BluetoothLeScanner scanner;
    private ScanCallback scanCb;

    // Classic side
    private android.bluetooth.BluetoothProfile a2dp, headset;
    private android.content.BroadcastReceiver btRx;
    /** LE advertisers seen in the scan: address → {name, hasJieliService, xiaomiEdrMac, rssi}. */
    private final java.util.Map<String, String[]> leSeen = new java.util.HashMap<>();
    private boolean waitingForLe;
    private String targetName = "";
    private int leTries;

    // Lab: Classic (RFCOMM) channel
    private volatile android.bluetooth.BluetoothSocket channel;
    private volatile String channelUuid = "";

    private static final long CONNECT_TIMEOUT_MS = 12_000;
    private static final String ACTION_BATTERY = "android.bluetooth.device.action.BATTERY_LEVEL_CHANGED";
    private static final String EXTRA_BATTERY = "android.bluetooth.device.extra.BATTERY_LEVEL";

    EarbudLink(Context c) {
        ctx = c;
        BluetoothAdapter a = null;
        try {
            a = ((android.bluetooth.BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE)).getAdapter();
        } catch (RuntimeException ignored) {
        }
        adapter = a;
        if (a != null) {
            android.bluetooth.BluetoothProfile.ServiceListener sl = new android.bluetooth.BluetoothProfile.ServiceListener() {
                @Override public void onServiceConnected(int profile, android.bluetooth.BluetoothProfile proxy) {
                    if (profile == android.bluetooth.BluetoothProfile.A2DP) a2dp = proxy; else headset = proxy;
                    if (targetMac != null) emitClassic(targetMac);
                }

                @Override public void onServiceDisconnected(int profile) {
                    if (profile == android.bluetooth.BluetoothProfile.A2DP) a2dp = null; else headset = null;
                }
            };
            try {
                a.getProfileProxy(c, sl, android.bluetooth.BluetoothProfile.A2DP);
                a.getProfileProxy(c, sl, android.bluetooth.BluetoothProfile.HEADSET);
            } catch (RuntimeException ignored) {
            }
        }
    }

    void setListener(Listener l) { listener = l; }

    boolean ready() {
        try { return adapter != null && adapter.isEnabled(); } catch (RuntimeException e) { return false; }
    }

    /** Start listening for Classic events (call from onResume). */
    void open() {
        if (btRx != null) return;
        btRx = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context c, android.content.Intent i) {
                BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                String mac = d == null ? null : d.getAddress();
                String a = i.getAction();
                if (ACTION_BATTERY.equals(a) && mac != null) {
                    int lvl = i.getIntExtra(EXTRA_BATTERY, -1);
                    if (lvl >= 0 && lvl <= 100 && mac.equals(targetMac)) emitBattery(hfpBatteryOf(lvl));
                }
                if (mac != null && mac.equals(targetMac)) emitClassic(mac);
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter();
        f.addAction(BluetoothDevice.ACTION_UUID);
        f.addAction(ACTION_BATTERY);
        f.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        f.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        f.addAction("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED");
        try {
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(btRx, f, Context.RECEIVER_EXPORTED);
            else ctx.registerReceiver(btRx, f);
        } catch (RuntimeException e) {
            btRx = null;
        }
    }

    /** Stop everything (call from onDestroy). */
    void close() {
        closeChannel();
        disconnect();
        stopScan();
        if (btRx != null) { try { ctx.unregisterReceiver(btRx); } catch (RuntimeException ignored) { } btRx = null; }
        try {
            if (a2dp != null) adapter.closeProfileProxy(android.bluetooth.BluetoothProfile.A2DP, a2dp);
            if (headset != null) adapter.closeProfileProxy(android.bluetooth.BluetoothProfile.HEADSET, headset);
        } catch (RuntimeException ignored) {
        }
    }

    // ----------------------------------------------------- bonded devices + rename

    /**
     * Every paired device, so nothing is missed — buds that claim no device type included.
     * {name, mac, tag}: tag "playing" (connected for audio now), "audio", or "".
     * Sorted: playing first, then audio, then the rest.
     */
    List<String[]> paired() {
        List<String[]> playing = new ArrayList<>(), audio = new ArrayList<>(), other = new ArrayList<>();
        if (adapter == null) return playing;
        try {
            for (BluetoothDevice d : adapter.getBondedDevices()) {
                String name = d.getName();
                String[] row = {name == null ? d.getAddress() : name, d.getAddress(), ""};
                if (isPlaying(d.getAddress())) { row[2] = "playing"; playing.add(row); }
                else if (looksAudio(d)) { row[2] = "audio"; audio.add(row); }
                else other.add(row);
            }
        } catch (RuntimeException ignored) {
        }
        playing.addAll(audio);
        playing.addAll(other);
        return playing;
    }

    private static boolean looksAudio(BluetoothDevice d) {
        try {
            if (d.getBluetoothClass() != null
                    && d.getBluetoothClass().getMajorDeviceClass() == android.bluetooth.BluetoothClass.Device.Major.AUDIO_VIDEO) return true;
            android.os.ParcelUuid[] us = d.getUuids();
            if (us != null) for (android.os.ParcelUuid u : us) {
                String s = u.toString();
                if (s.startsWith("0000110b") || s.startsWith("0000111e") || s.startsWith("00001108")) return true;
            }
        } catch (RuntimeException ignored) {
        }
        return false;
    }

    /** True when this device is connected for music or calls right now. */
    boolean isPlaying(String mac) {
        for (android.bluetooth.BluetoothProfile p : new android.bluetooth.BluetoothProfile[]{a2dp, headset}) {
            if (p == null) continue;
            try {
                for (BluetoothDevice d : p.getConnectedDevices()) if (d.getAddress().equals(mac)) return true;
            } catch (RuntimeException ignored) {
            }
        }
        return false;
    }

    /** Headset battery Android got over the call profile (HFP), if the buds report one. -1 if not. */
    int hfpBattery(String mac) {
        try {
            BluetoothDevice d = adapter.getRemoteDevice(mac);
            Object r = BluetoothDevice.class.getMethod("getBatteryLevel").invoke(d);
            if (r instanceof Integer && (Integer) r >= 0 && (Integer) r <= 100) return (Integer) r;
        } catch (ReflectiveOperationException | RuntimeException ignored) {
        }
        return -1;
    }

    private static Earbuds.Battery hfpBatteryOf(int lvl) {
        Earbuds.Battery b = new Earbuds.Battery();
        b.single = lvl;
        b.source = "Headset battery (what Android sees)";
        return b;
    }

    /** Builds the Classic-side picture of a paired device from what Android has cached. */
    ClassicReport classicReport(String mac) {
        ClassicReport r = new ClassicReport();
        r.mac = mac;
        try {
            BluetoothDevice d = adapter.getRemoteDevice(mac);
            String n = d.getName();
            r.name = n == null ? mac : n;
            r.type = Earbuds.deviceType(d.getType());
            if (d.getBluetoothClass() != null) r.claims = Earbuds.deviceClass(d.getBluetoothClass().getDeviceClass());
            android.os.ParcelUuid[] us = d.getUuids();
            List<String> clues = new ArrayList<>();
            if (us != null) for (android.os.ParcelUuid u : us) {
                String s = u.toString();
                String name = Earbuds.classicService(s);
                if (name == null) continue;
                r.services.add(new String[]{name, s});
                clues.add(name);
                boolean vendor = name.startsWith("Vendor control") || name.contains("RACE") || name.contains("GAIA")
                        || name.contains("Serial port") || name.contains("Sony");
                if (vendor) r.vendorChannels.add(s);
            }
            String oui = Earbuds.ouiVendor(mac);
            if (oui != null) { r.vendor = oui; clues.add(oui); }
            String v = Earbuds.chipVerdict(clues);
            r.verdict = v == null ? "" : v;
        } catch (RuntimeException ignored) {
        }
        r.playing = isPlaying(mac);
        r.hfpBattery = hfpBattery(mac);
        return r;
    }

    private void emitClassic(String mac) {
        ClassicReport r = classicReport(mac);
        if (r.hfpBattery >= 0) emitBattery(hfpBatteryOf(r.hfpBattery));
        post(() -> { if (listener != null) listener.classic(r); });
    }

    /** Renames the device everywhere when Android allows it (12+), always keeps a nickname in Melad. */
    boolean rename(String mac, String newName) {
        boolean systemWide = false;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                int r = adapter.getRemoteDevice(mac).setAlias(newName);
                systemWide = r == android.bluetooth.BluetoothStatusCodes.SUCCESS;
            }
        } catch (RuntimeException ignored) {
            // Android only allows apps paired through its "companion device" flow to rename
        }
        History.rename(ctx, mac, newName);
        return systemWide;
    }

    // ----------------------------------------------------- passive scan

    void startScan() {
        if (!ready() || scanner != null) return;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        scanCb = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) { onAdvertisement(r); }
            @Override public void onBatchScanResults(List<ScanResult> rs) { for (ScanResult r : rs) onAdvertisement(r); }
            @Override public void onScanFailed(int code) { post(() -> { if (listener != null) listener.status("Scan failed (" + code + ")"); }); }
        };
        try {
            scanner.startScan(scanCb);
        } catch (RuntimeException e) {
            scanner = null;
        }
    }

    void stopScan() {
        if (scanner != null && scanCb != null) {
            try { scanner.stopScan(scanCb); } catch (RuntimeException ignored) { }
        }
        scanner = null;
        scanCb = null;
    }

    private void onAdvertisement(ScanResult r) {
        ScanRecord rec = r.getScanRecord();
        if (rec == null) return;
        remember(r, rec);
        Earbuds.Battery b = null;
        byte[] apple = rec.getManufacturerSpecificData(APPLE_COMPANY);
        if (apple != null) b = Earbuds.apple(apple);
        if (b == null) {
            byte[] xi = rec.getManufacturerSpecificData(XIAOMI_COMPANY);
            if (xi != null) b = Earbuds.xiaomi(xi);
        }
        if (b == null) {
            byte[] fd2d = rec.getServiceData(new android.os.ParcelUuid(XIAOMI_FD2D));
            if (fd2d != null) b = Earbuds.xiaomiFd2d(fd2d);
        }
        if (b == null || !b.any()) return;
        String name = null;
        try { name = r.getDevice().getName(); } catch (RuntimeException ignored) { }
        if (b.model.isEmpty()) b.model = name == null ? r.getDevice().getAddress() : name;
        final Earbuds.Battery fb = b;
        post(() -> { if (listener != null) listener.battery(fb); });
    }

    /** Notes every LE advertiser so connect() can find the buds' real LE address. */
    private void remember(ScanResult r, ScanRecord rec) {
        String addr = r.getDevice().getAddress();
        String name = rec.getDeviceName();
        boolean jieli = false;
        if (rec.getServiceUuids() != null)
            for (android.os.ParcelUuid u : rec.getServiceUuids()) if (JL_SERVICE.equals(u.getUuid())) jieli = true;
        if (rec.getManufacturerSpecificData(0x05D6) != null) jieli = true;
        String edr = Earbuds.xiaomiEdrMac(rec.getManufacturerSpecificData(XIAOMI_COMPANY));
        String[] row = {name == null ? "" : name, jieli ? "1" : "0", edr == null ? "" : edr, Integer.toString(r.getRssi())};
        boolean isNew;
        synchronized (leSeen) { isNew = leSeen.put(addr, row) == null; }
        // a matching advertiser showed up after we started waiting: try it now
        if (isNew && waitingForLe && targetMac != null) {
            String le = findLeAddress(targetMac, targetName);
            if (le != null) post(() -> { if (waitingForLe) startLe(le); });
        }
    }

    /** The LE address belonging to the paired buds, by embedded address, same address, or same name. */
    private String findLeAddress(String mac, String name) {
        String best = null;
        int bestScore = Integer.MIN_VALUE;
        synchronized (leSeen) {
            for (java.util.Map.Entry<String, String[]> e : leSeen.entrySet()) {
                String[] v = e.getValue();
                int score;
                if (mac.equalsIgnoreCase(v[2])) score = 1000;                      // address embedded in the ad
                else if (mac.equalsIgnoreCase(e.getKey())) score = 900;            // same address (dual-mode)
                else if (!name.isEmpty() && name.equalsIgnoreCase(v[0])) score = 500; // same name
                else continue;
                if (v[1].equals("1")) score += 100;                                 // advertises the JieLi service
                try { score += Integer.parseInt(v[3]) / 10; } catch (NumberFormatException ignored) { }
                if (score > bestScore) { bestScore = score; best = e.getKey(); }
            }
        }
        return best;
    }

    // ----------------------------------------------------- connect

    /**
     * Shows the Classic picture at once (works while you're listening), then looks for an LE
     * control link: the buds' own LE address if the scan found one, else the same address.
     * The LE attempt has a timeout and never blocks the screen.
     */
    void connect(String mac) {
        disconnect();
        targetMac = mac;
        rule = History.rule(ctx, mac);
        authed = false;
        voiceModeRecord = null;
        latencyMs = -1;
        leTries = 0;
        reader.feed(new byte[0]);
        try {
            BluetoothDevice dev = adapter.getRemoteDevice(mac);
            String n = dev.getName();
            targetName = n == null ? "" : n;
            dev.fetchUuidsWithSdp(); // refreshes the Classic service list; arrives as ACTION_UUID
        } catch (RuntimeException e) {
            targetName = "";
        }
        emitClassic(mac);
        History.seen(ctx, mac, targetName, classicReport(mac).verdict);
        if (rule != null && rule.usable() && rule.chr.startsWith("classic:")) {
            final String ch = rule.chr.substring(8);
            main.postDelayed(() -> { if (mac.equals(targetMac)) openChannel(ch); }, 1500); // your taught Classic rule
        }
        startScan();
        String le = findLeAddress(mac, targetName);
        startLe(le != null ? le : mac);
    }

    private void startLe(String leMac) {
        waitingForLe = false;
        if (gatt != null) { try { gatt.close(); } catch (RuntimeException ignored) { } gatt = null; }
        leTries++;
        try {
            BluetoothDevice dev = adapter.getRemoteDevice(leMac);
            status("Recognised over Classic · looking for a control link"
                    + (leMac.equals(targetMac) ? "…" : " at " + leMac + "…"));
            gatt = dev.connectGatt(ctx, false, callback, BluetoothDevice.TRANSPORT_LE);
            main.removeCallbacks(leTimeout);
            main.postDelayed(leTimeout, CONNECT_TIMEOUT_MS);
        } catch (RuntimeException e) {
            leGaveUp("LE not available (" + e.getClass().getSimpleName() + ")");
        }
    }

    private final Runnable leTimeout = () -> {
        if (connectedSince > 0) return;
        if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (RuntimeException ignored) { } gatt = null; }
        leGaveUp("no answer on Bluetooth LE");
    };

    /** No LE link (yet): say so plainly, keep everything Classic gave us, and keep watching the scan. */
    private void leGaveUp(String why) {
        waitingForLe = leTries < 3; // a matching advertiser may still appear (open the case)
        status("Recognised over Classic Bluetooth · " + why + ". Battery shows if the buds report it; "
                + "try the Lab's Classic channel for controls.");
        log("LE control link: " + why);
    }

    void disconnect() {
        waitingForLe = false;
        main.removeCallbacks(leTimeout);
        if (gatt != null && targetMac != null && connectedSince > 0) {
            History.addConnectedTime(ctx, targetMac, SystemClock.elapsedRealtime() - connectedSince);
        }
        connectedSince = 0;
        authed = false;
        opBusy = false;
        ops.clear();
        main.removeCallbacks(rssiTick);
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (RuntimeException ignored) { }
            gatt = null;
        }
    }

    boolean isConnected() { return gatt != null && connectedSince > 0; }

    boolean isAuthed() { return authed; }

    boolean ancAvailable() { return voiceModeRecord != null; }

    String verdict() { return verdict; }

    // ----------------------------------------------------- GATT callbacks

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int s, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                main.removeCallbacks(leTimeout);
                waitingForLe = false;
                connectedSince = SystemClock.elapsedRealtime();
                status("Control link up · reading services…");
                try { g.requestMtu(517); } catch (RuntimeException ignored) { }
                main.postDelayed(() -> { try { g.discoverServices(); } catch (RuntimeException ignored) { } }, 300);
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                boolean was = connectedSince > 0;
                if (was && targetMac != null) History.addConnectedTime(ctx, targetMac, SystemClock.elapsedRealtime() - connectedSince);
                connectedSince = 0;
                authed = false;
                main.removeCallbacks(rssiTick);
                main.removeCallbacks(leTimeout);
                post(() -> {
                    if (gatt == g) { try { g.close(); } catch (RuntimeException ignored) { } gatt = null; }
                    if (was) status("Control link closed · Classic audio is unaffected");
                    else leGaveUp("refused (code " + s + ")");
                });
            }
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int s) { }

        @Override public void onServicesDiscovered(BluetoothGatt g, int s) { inspectAndStart(g); }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int s) { opDone(); }

        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int s) { opDone(); }

        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value, int s) {
            onRead(ch.getUuid(), value, s);
            opDone();
        }

        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int s) {
            onRead(ch.getUuid(), ch.getValue(), s);
            opDone();
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) { onNotify(ch.getUuid(), value); }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) { onNotify(ch.getUuid(), ch.getValue()); }

        @Override public void onReadRemoteRssi(BluetoothGatt g, int r, int s) {
            if (s == BluetoothGatt.GATT_SUCCESS) { rssi = r; emitDiag(); }
        }
    };

    // ----------------------------------------------------- inspect + start every path

    private void inspectAndStart(BluetoothGatt g) {
        List<String[]> rows = new ArrayList<>();
        List<String> clues = new ArrayList<>();
        BluetoothGattService jl = null, battery = null, devinfo = null;
        for (BluetoothGattService svc : g.getServices()) {
            String sname = Earbuds.service(svc.getUuid().toString());
            if (sname != null) clues.add(sname);
            if (JL_SERVICE.equals(svc.getUuid())) jl = svc;
            if (BATTERY_SVC.equals(svc.getUuid())) battery = svc;
            if (DEVINFO_SVC.equals(svc.getUuid())) devinfo = svc;
            String svcLabel = sname != null ? sname : "Service " + shortUuid(svc.getUuid());
            for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) {
                rows.add(new String[]{svcLabel, charName(ch.getUuid()), props(ch.getProperties()), ch.getUuid().toString()});
            }
        }
        verdict = Earbuds.chipVerdict(clues);
        if (verdict == null) verdict = "";
        post(() -> { if (listener != null) listener.inspector(rows); });
        log("Found " + rows.size() + " characteristics across " + g.getServices().size() + " services"
                + (verdict.isEmpty() ? "" : " · looks like " + verdict));

        // 1. Device Information — maker / model / firmware
        if (devinfo != null) {
            readIfPresent(devinfo, MANUFACTURER);
            readIfPresent(devinfo, MODEL);
            readIfPresent(devinfo, FIRMWARE);
            readIfPresent(devinfo, SERIAL);
        }
        // 2. Standard battery service (universal fallback), plus subscribe for updates
        if (battery != null) {
            BluetoothGattCharacteristic lvl = battery.getCharacteristic(BATTERY_LEVEL);
            if (lvl != null) { enqueueRead(lvl); subscribe(lvl); }
        }
        // 3. A rule you taught this device
        if (rule != null && rule.usable()) {
            BluetoothGattCharacteristic rc = findChar(g, rule.svc, rule.chr);
            if (rc != null) { subscribe(rc); log("Using your custom rule on " + shortUuid(rc.getUuid())); }
        }
        // 4. JieLi RCSP — the rich path
        if (jl != null) {
            jlWrite = jl.getCharacteristic(JL_WRITE);
            BluetoothGattCharacteristic notify = jl.getCharacteristic(JL_NOTIFY);
            if (jlWrite != null && notify != null) {
                subscribe(notify);
                status("JieLi earbuds — authenticating…");
                enqueueOp(this::startHandshake);
            } else {
                status(finalStatus(battery != null));
            }
        } else {
            status(finalStatus(battery != null));
        }
        History.seen(ctx, targetMac, nameOf(), verdict);
        main.removeCallbacks(rssiTick);
        main.post(rssiTick);
    }

    private String finalStatus(boolean hasStdBattery) {
        if (!verdict.isEmpty() && hasStdBattery) return verdict + " · battery live, no adjustable modes found";
        if (!verdict.isEmpty()) return verdict + " · no control service; battery from scan or Lab";
        if (hasStdBattery) return "Connected · standard battery; open Lab to find controls";
        return "Connected · unrecognised. Open Lab to read it and teach a rule";
    }

    private void readIfPresent(BluetoothGattService svc, UUID u) {
        BluetoothGattCharacteristic ch = svc.getCharacteristic(u);
        if (ch != null) enqueueRead(ch);
    }

    // ----------------------------------------------------- reads / notifications

    private String maker = "", model = "", firmware = "";

    private void onRead(UUID u, byte[] v, int status) {
        if (status != BluetoothGatt.GATT_SUCCESS || v == null) return;
        if (BATTERY_LEVEL.equals(u)) {
            Earbuds.Battery b = Earbuds.standardBattery(v);
            if (b != null) emitBattery(b);
        } else if (MANUFACTURER.equals(u)) { maker = str(v); emitDeviceInfo(); }
        else if (MODEL.equals(u)) { model = str(v); emitDeviceInfo(); }
        else if (FIRMWARE.equals(u)) { firmware = str(v); emitDeviceInfo(); }
        else if (SERIAL.equals(u)) { /* kept private */ }
        post(() -> { if (listener != null) listener.raw(u.toString(), v); });
    }

    private void onNotify(UUID u, byte[] v) {
        if (v == null || v.length == 0) return;
        if (JL_NOTIFY.equals(u)) { handleJieli(v); return; }
        if (BATTERY_LEVEL.equals(u)) {
            Earbuds.Battery b = Earbuds.standardBattery(v);
            if (b != null) emitBattery(b);
        }
        if (rule != null && rule.usable() && sameUuid(rule.chr, u)) {
            Earbuds.Battery b = rule.apply(v);
            if (b != null) emitBattery(b);
        }
        post(() -> { if (listener != null) listener.raw(u.toString(), v); });
    }

    // ----------------------------------------------------- JieLi RCSP

    private void startHandshake() {
        byte[] rnd = new byte[16];
        new java.security.SecureRandom().nextBytes(rnd);
        rawWrite(jlWrite, Earbuds.concat(new byte[]{0x00}, rnd));
    }

    private void handleJieli(byte[] value) {
        if (!authed) {
            if (value[0] == 0x01 && value.length == 17) { rawWrite(jlWrite, Earbuds.AUTH_PASS); return; }
            if (value[0] == 0x00 && value.length == 17) {
                rawWrite(jlWrite, Earbuds.concat(new byte[]{0x01}, JlAuth.encrypt(java.util.Arrays.copyOfRange(value, 1, 17))));
                return;
            }
            if (value.length >= 5 && value[0] == 0x02 && value[1] == 'p') {
                authed = true;
                status("Connected · " + (verdict.isEmpty() ? "JieLi" : verdict) + " · reading…");
                command(Earbuds.getAdvInfo(sn++));
                command(Earbuds.getVoiceMode(sn++));
                return;
            }
        }
        for (Earbuds.Frame f : reader.feed(value)) onFrame(f);
    }

    private void onFrame(Earbuds.Frame f) {
        if (!f.isCommand() && cmdSentAt > 0) { latencyMs = (int) (SystemClock.elapsedRealtime() - cmdSentAt); cmdSentAt = 0; emitDiag(); }
        switch (f.op) {
            case Earbuds.RCSP_ADV_PUSH: {
                Earbuds.Battery b = Earbuds.jieliPush(f.params);
                if (b != null) emitBattery(b);
                break;
            }
            case Earbuds.RCSP_GET_ADV: {
                Earbuds.JieliInfo info = Earbuds.parseAdvInfo(f.params);
                post(() -> {
                    if (listener == null) return;
                    if (info.battery != null) listener.battery(info.battery);
                    listener.controls(info);
                });
                break;
            }
            case Earbuds.RCSP_GET_SYS_INFO:
            case Earbuds.RCSP_SET_SYS_INFO: {
                byte[] rec = Earbuds.voiceModeRecord(f.params);
                if (rec != null) voiceModeRecord = rec;
                break;
            }
            case Earbuds.RCSP_DEV_REQUEST:
                if (f.wantsReply()) command(Earbuds.rcspReply(Earbuds.RCSP_DEV_REQUEST, f.sn));
                break;
            default:
                break;
        }
    }

    void refresh() { if (authed) { command(Earbuds.getAdvInfo(sn++)); command(Earbuds.getVoiceMode(sn++)); } }

    void setGameMode(boolean on) {
        if (!authed) return;
        log("Work mode → " + (on ? "gaming" : "normal"));
        command(Earbuds.setAdv(sn++, Earbuds.ADV_WORK_MODE, new byte[]{(byte) (on ? 2 : 1)}));
        command(Earbuds.getAdvInfo(sn++));
    }

    void setMicChannel(int channel) {
        if (!authed) return;
        command(Earbuds.setAdv(sn++, Earbuds.ADV_MIC, new byte[]{(byte) channel}));
        command(Earbuds.getAdvInfo(sn++));
    }

    void setAnc(int mode) {
        if (!authed || voiceModeRecord == null) { log("ANC not reported by this firmware"); return; }
        log("Noise control → " + mode);
        command(Earbuds.setVoiceMode(sn++, voiceModeRecord, mode));
        command(Earbuds.getVoiceMode(sn++));
    }

    private void command(byte[] frame) {
        if (jlWrite == null) return;
        cmdSentAt = SystemClock.elapsedRealtime();
        rawWrite(jlWrite, frame);
    }

    // ----------------------------------------------------- the Lab (raw access, teaching rules)

    /** Characteristics that can be written or notify, for the Lab list. {label, uuid, props}. */
    List<String[]> labChars() {
        List<String[]> out = new ArrayList<>();
        if (gatt == null) return out;
        for (BluetoothGattService svc : gatt.getServices()) {
            String sname = Earbuds.service(svc.getUuid().toString());
            for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) {
                int p = ch.getProperties();
                boolean usable = (p & (BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
                        | BluetoothGattCharacteristic.PROPERTY_NOTIFY
                        | BluetoothGattCharacteristic.PROPERTY_INDICATE
                        | BluetoothGattCharacteristic.PROPERTY_READ)) != 0;
                if (usable) out.add(new String[]{(sname != null ? sname : shortUuid(svc.getUuid())) + " / " + charName(ch.getUuid()),
                        ch.getUuid().toString(), props(p)});
            }
        }
        return out;
    }

    void labSubscribe(String charUuid) {
        BluetoothGattCharacteristic ch = findCharByUuid(charUuid);
        if (ch != null) { subscribe(ch); log("Watching " + shortUuid(ch.getUuid())); }
    }

    void labRead(String charUuid) {
        BluetoothGattCharacteristic ch = findCharByUuid(charUuid);
        if (ch != null) enqueueRead(ch);
    }

    void labWrite(String charUuid, byte[] data) {
        BluetoothGattCharacteristic ch = findCharByUuid(charUuid);
        if (ch == null) { log("No such characteristic"); return; }
        int p = ch.getProperties();
        int type = (p & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
        log("Write " + Earbuds.hex(data) + " → " + shortUuid(ch.getUuid()));
        write(ch, data, type);
    }

    /** Saves a rule you worked out in the Lab, so battery shows automatically next time. */
    void teachRule(Earbuds.CustomRule r) {
        rule = r;
        History.setRule(ctx, targetMac, r);
        if (r != null && r.usable()) {
            BluetoothGattCharacteristic ch = findChar(gatt, r.svc, r.chr);
            if (ch != null) subscribe(ch);
            log("Saved a custom rule for this device");
        }
    }

    Earbuds.CustomRule currentRule() { return rule; }

    // ----------------------------------------------------- Lab: Classic (RFCOMM) channel

    /** Classic channels the paired buds offer (vendor apps use these to control clone chips). */
    List<String> classicChannels() {
        return targetMac == null ? new ArrayList<>() : classicReport(targetMac).vendorChannels;
    }

    boolean channelOpen() { return channel != null; }

    /** Opens a raw Classic channel to the buds, the way a vendor app does. Bytes received go to raw(). */
    void openChannel(String uuid) {
        closeChannel();
        if (targetMac == null) return;
        final String mac = targetMac;
        log("Opening Classic channel " + uuid.substring(0, 8) + "…");
        new Thread(() -> {
            android.bluetooth.BluetoothSocket s = null;
            try {
                try { adapter.cancelDiscovery(); } catch (RuntimeException ignored) { }
                s = adapter.getRemoteDevice(mac).createRfcommSocketToServiceRecord(UUID.fromString(uuid));
                s.connect();
                channel = s;
                channelUuid = uuid;
                log("Classic channel open — send hex from the Lab, replies show in Activity");
                java.io.InputStream in = s.getInputStream();
                byte[] buf = new byte[1024];
                for (int n; (n = in.read(buf)) > 0; ) {
                    final byte[] got = java.util.Arrays.copyOf(buf, n);
                    Earbuds.CustomRule rr = rule;
                    if (rr != null && rr.usable() && ("classic:" + uuid).equalsIgnoreCase(rr.chr)) {
                        Earbuds.Battery bt = rr.apply(got);
                        if (bt != null) emitBattery(bt);
                    }
                    post(() -> { if (listener != null) listener.raw("classic:" + uuid, got); });
                }
            } catch (java.io.IOException | RuntimeException e) {
                log("Classic channel: " + (channel == null ? "could not open (" + e.getMessage() + ")" : "closed"));
            } finally {
                if (s != null) try { s.close(); } catch (java.io.IOException ignored) { }
                if (channel == s) { channel = null; channelUuid = ""; }
            }
        }, "melad-rfcomm").start();
    }

    void channelWrite(byte[] data) {
        android.bluetooth.BluetoothSocket s = channel;
        if (s == null) { log("Open a Classic channel first"); return; }
        new Thread(() -> {
            try {
                s.getOutputStream().write(data);
                s.getOutputStream().flush();
                log("Sent " + Earbuds.hex(data) + " on Classic channel");
            } catch (java.io.IOException e) {
                log("Send failed: " + e.getMessage());
            }
        }, "melad-rfcomm-tx").start();
    }

    void closeChannel() {
        android.bluetooth.BluetoothSocket s = channel;
        channel = null;
        channelUuid = "";
        if (s != null) try { s.close(); } catch (java.io.IOException ignored) { }
    }

    // ----------------------------------------------------- serial GATT op queue

    private void enqueueOp(Runnable r) {
        ops.add(r);
        pump();
    }

    private void enqueueRead(BluetoothGattCharacteristic ch) {
        enqueueOp(() -> { if (gatt == null || !gatt.readCharacteristic(ch)) opDone(); });
    }

    private void write(BluetoothGattCharacteristic ch, byte[] data, int type) {
        enqueueOp(() -> doWrite(ch, data, type));
    }

    /** Fire-and-forget write used for the RCSP command stream. */
    private void rawWrite(BluetoothGattCharacteristic ch, byte[] data) {
        enqueueOp(() -> doWrite(ch, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE));
    }

    private void doWrite(BluetoothGattCharacteristic ch, byte[] data, int type) {
        if (gatt == null) { opDone(); return; }
        boolean started;
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                started = gatt.writeCharacteristic(ch, data, type) == android.bluetooth.BluetoothStatusCodes.SUCCESS;
            } else {
                ch.setWriteType(type);
                ch.setValue(data);
                started = gatt.writeCharacteristic(ch);
            }
        } catch (RuntimeException e) {
            started = false;
        }
        if (!started) opDone();
        // NO_RESPONSE writes don't always call back; a token-guarded timer advances the queue.
        else if (type == BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) {
            final int t = opToken;
            main.postDelayed(() -> { if (opBusy && opToken == t) opDone(); }, 150);
        }
    }

    private void subscribe(BluetoothGattCharacteristic ch) {
        enqueueOp(() -> {
            if (gatt == null) { opDone(); return; }
            try { gatt.setCharacteristicNotification(ch, true); } catch (RuntimeException ignored) { }
            BluetoothGattDescriptor cccd = ch.getDescriptor(CCCD);
            if (cccd == null) { opDone(); return; }
            boolean indicate = (ch.getProperties() & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0;
            byte[] val = indicate ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
            boolean started;
            try {
                if (Build.VERSION.SDK_INT >= 33) started = gatt.writeDescriptor(cccd, val) == android.bluetooth.BluetoothStatusCodes.SUCCESS;
                else { cccd.setValue(val); started = gatt.writeDescriptor(cccd); }
            } catch (RuntimeException e) {
                started = false;
            }
            if (!started) opDone();
        });
    }

    private void pump() {
        if (opBusy || gatt == null) return;
        Runnable r = ops.poll();
        if (r == null) return;
        opBusy = true;
        opToken++;
        try { r.run(); } catch (RuntimeException e) { opBusy = false; pump(); }
    }

    private void opDone() {
        if (!opBusy) return;
        opBusy = false;
        opToken++;
        pump();
    }

    // ----------------------------------------------------- diagnostics

    private final Runnable rssiTick = new Runnable() {
        @Override public void run() {
            if (gatt == null) return;
            try { gatt.readRemoteRssi(); } catch (RuntimeException ignored) { }
            emitDiag();
            main.postDelayed(this, 3000);
        }
    };

    private void emitDiag() {
        long up = connectedSince > 0 ? SystemClock.elapsedRealtime() - connectedSince : 0;
        post(() -> { if (listener != null) listener.diagnostics(latencyMs, rssi, up); });
    }

    // ----------------------------------------------------- helpers

    private String nameOf() {
        try { String n = adapter.getRemoteDevice(targetMac).getName(); if (n != null) return n; } catch (RuntimeException ignored) { }
        return targetMac;
    }

    private void emitBattery(Earbuds.Battery b) {
        if (targetMac != null) History.setBattery(ctx, targetMac, b.toString());
        post(() -> { if (listener != null) listener.battery(b); });
    }

    private void emitDeviceInfo() {
        post(() -> { if (listener != null) listener.deviceInfo(maker, model, firmware); });
        if (targetMac != null) History.setDeviceInfo(ctx, targetMac, model, firmware);
    }

    private BluetoothGattCharacteristic findChar(BluetoothGatt g, String svcUuid, String chrUuid) {
        if (g == null) return null;
        for (BluetoothGattService svc : g.getServices()) {
            if (!sameUuid(svcUuid, svc.getUuid())) continue;
            for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) if (sameUuid(chrUuid, ch.getUuid())) return ch;
        }
        return null;
    }

    private BluetoothGattCharacteristic findCharByUuid(String chrUuid) {
        if (gatt == null) return null;
        for (BluetoothGattService svc : gatt.getServices())
            for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) if (sameUuid(chrUuid, ch.getUuid())) return ch;
        return null;
    }

    private static boolean sameUuid(String a, UUID b) {
        return a != null && (a.equalsIgnoreCase(b.toString()) || a.equalsIgnoreCase(shortUuid(b)));
    }

    private static String shortUuid(UUID u) {
        String s = u.toString();
        return s.startsWith("0000") && s.endsWith("-0000-1000-8000-00805f9b34fb") ? s.substring(4, 8).toUpperCase(Locale.ROOT) : s;
    }

    private static String charName(UUID u) {
        String s = shortUuid(u);
        switch (s) {
            case "2A19": return "Battery level";
            case "2A29": return "Manufacturer";
            case "2A24": return "Model";
            case "2A26": return "Firmware";
            case "2A25": return "Serial";
            case "AE01": return "JieLi write";
            case "AE02": return "JieLi notify";
            default: return s;
        }
    }

    private static String props(int p) {
        StringBuilder b = new StringBuilder();
        if ((p & BluetoothGattCharacteristic.PROPERTY_READ) != 0) b.append('R');
        if ((p & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) b.append('W');
        if ((p & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) b.append('N');
        if ((p & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) b.append('I');
        return b.length() == 0 ? "-" : b.toString();
    }

    private static String str(byte[] v) {
        int n = v.length;
        while (n > 0 && (v[n - 1] == 0 || v[n - 1] == '\n' || v[n - 1] == '\r')) n--;
        return new String(v, 0, n, java.nio.charset.StandardCharsets.UTF_8).trim();
    }

    private void status(String s) { post(() -> { if (listener != null) listener.status(s); }); }

    private void log(String s) { post(() -> { if (listener != null) listener.log(s); }); }

    private void post(Runnable r) { main.post(r); }
}

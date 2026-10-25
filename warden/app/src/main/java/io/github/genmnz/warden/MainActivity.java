package io.github.genmnz.warden;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.VpnService;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Single settings screen, built in code (no layout files, no libraries). */
public final class MainActivity extends Activity {
    private static final int REQ_VPN = 1, REQ_IMPORT = 2, REQ_MAP = 3;

    private SharedPreferences prefs;
    private LinearLayout root;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Ui u;
    private TextView[] banner;
    private TextView chipBlock, chipLoc, chipLock, lockdownNotice, dnsWarn;
    private TextView dnsSub, listsSub, spoofSub, permSub, lockSub;
    private TextView pillAlways, pillLockdown, pillBattery, pillAdmin, upstreamSub;
    private Switch dnsSwitch, spoofSwitch;
    private boolean quiet; // set while the UI mirrors saved state, so listeners don't fire actions
    private EditText lat, lon;
    private LinearLayout lockList;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            refreshStatus();
            ui.postDelayed(this, 2000);
        }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        CrashLog.install(this);
        if (getActionBar() != null) getActionBar().hide(); // the bold in-page title replaces it
        prefs = Store.prefs(this);
        u = new Ui(this);
        root = u.page(this);
        build();
        CrashLog.offer(this);
    }

    @Override protected void onResume() {
        super.onResume();
        ui.post(tick);
        rebuildLocks();
    }

    @Override protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    // ------------------------------------------------------------------ layout

    private void build() {
        u.title(root, "Melad", "Your privacy toolbox · everything stays on this phone");
        banner = u.banner(root);
        LinearLayout chips = new LinearLayout(this);
        chips.setPadding(0, dp(10), 0, 0);
        chipBlock = u.pill("Blocking", Ui.State.OFF);
        chipLoc = u.pill("Location", Ui.State.OFF);
        chipLock = u.pill("Settings lock", Ui.State.OFF);
        for (TextView t : new TextView[]{chipBlock, chipLoc, chipLock}) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
            lp.rightMargin = dp(8);
            chips.addView(t, lp);
        }
        root.addView(chips);
        lockdownNotice = u.notice(root, Ui.State.BAD);
        lockdownNotice.setOnClickListener(v -> open(Settings.ACTION_VPN_SETTINGS));

        // --- blocking
        u.section(root, "Blocking");
        LinearLayout c = u.card(root);
        dnsSwitch = u.toggle(prefs.getBoolean("dns_on", false));
        dnsSwitch.setOnCheckedChangeListener((v, on) -> {
            if (quiet) return;
            if (on) {
                Intent i = VpnService.prepare(this);
                if (i != null) { startActivityForResult(i, REQ_VPN); return; }
            }
            prefs.edit().putBoolean("dns_on", on).apply();
            Engine.sync(this);
            refreshStatus();
        });
        dnsSub = u.row(c, "Block ads, trackers & telemetry", "Off", dnsSwitch);
        Switch hard = u.toggle(prefs.getBoolean("catch_hardcoded", true));
        hard.setOnCheckedChangeListener((v, on) -> { prefs.edit().putBoolean("catch_hardcoded", on).apply(); restartDns(); });
        u.row(c, "Catch apps with their own DNS", "Stops apps skipping the filter through Google or Cloudflare DNS", hard);
        u.buttons(c, "Recent lookups", (View.OnClickListener) v -> showLog(), "Upstream DNS", (View.OnClickListener) v -> editUpstream());
        dnsWarn = u.notice(root, Ui.State.WARN);

        // --- lists
        u.section(root, "Block lists");
        LinearLayout lists = u.card(root);
        for (Store.Source src : Store.SOURCES) {
            Switch sw = u.toggle(Store.enabled(this, src));
            sw.setOnCheckedChangeListener((v, on) -> {
                prefs.edit().putBoolean("cat_" + src.id, on).apply();
                if (on && src.asset == null && !Store.cacheFile(this, src).exists()) downloadThen(src);
                else recompile();
            });
            u.row(lists, src.label, src.desc, sw);
        }
        Switch auto = u.toggle(prefs.getBoolean("auto_update", true));
        auto.setOnCheckedChangeListener((v, on) -> prefs.edit().putBoolean("auto_update", on).apply());
        listsSub = u.row(lists, "Update automatically", "", auto);
        u.buttons(lists, "Update now", (View.OnClickListener) v -> updateLists(),
                "My lists", (View.OnClickListener) v -> editLists(),
                "Import", (View.OnClickListener) v -> pickImport());

        // --- earbuds
        u.section(root, "Earbuds");
        LinearLayout buds = u.card(root);
        u.link(buds, "My earbuds", "Recognise any buds · battery · game mode · Lab",
                v -> startActivity(new Intent(this, EarbudsActivity.class)));

        // --- location
        u.section(root, "Location");
        LinearLayout loc = u.card(root);
        spoofSwitch = u.toggle(prefs.getBoolean("spoof_on", false));
        spoofSwitch.setOnCheckedChangeListener((v, on) -> {
            if (quiet) return;
            if (on && !saveSpot()) { quiet = true; v.setChecked(false); quiet = false; return; }
            prefs.edit().putBoolean("spoof_on", on).apply();
            Engine.sync(this);
            refreshStatus();
        });
        spoofSub = u.row(loc, "Use my marked spot", "Off", spoofSwitch);
        u.divider(loc);
        LinearLayout ll = new LinearLayout(this);
        ll.setPadding(0, dp(6), 0, dp(6));
        lat = number(prefs.getString("lat", ""), "Latitude");
        lon = number(prefs.getString("lon", ""), "Longitude");
        ll.addView(lat, new LinearLayout.LayoutParams(0, -2, 1));
        ll.addView(lon, new LinearLayout.LayoutParams(0, -2, 1));
        loc.addView(ll);
        u.buttons(loc, "Pick on map", (View.OnClickListener) v -> {
                    Intent i = new Intent(this, MapActivity.class)
                            .putExtra(MapActivity.EXTRA_LAT, parse(lat, 0)).putExtra(MapActivity.EXTRA_LON, parse(lon, 0));
                    startActivityForResult(i, REQ_MAP);
                },
                "Mock-location setting", (View.OnClickListener) v -> open(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
        TextView how = u.tv("While this is on, Melad switches Location on for you (apps can't get any position otherwise), "
                + "replaces GPS, Wi-Fi and cell positioning with your spot, and switches Location back off when you stop.", 13, u.sub, false);
        how.setPadding(dp(4), dp(10), dp(4), 0);
        root.addView(how);

        // --- settings lock
        u.section(root, "Settings lock");
        LinearLayout lk = u.card(root);
        permSub = u.row(lk, "Permission", "", null);
        lockList = new LinearLayout(this);
        lockList.setOrientation(LinearLayout.VERTICAL);
        u.divider(lk);
        lk.addView(lockList);
        lockSub = u.row(lk, "Changes undone", "None yet", null);
        u.buttons(lk, "Lock another setting", (View.OnClickListener) v -> addCustomLock(),
                "Allow system settings", (View.OnClickListener) v -> open(Settings.ACTION_MANAGE_WRITE_SETTINGS, true));
        TextView lockHow = u.tv("Switch a setting on to keep its current value. If a SIM, eSIM or carrier update "
                + "changes it, Melad puts it back straight away. Set it the way you like in Settings first.", 13, u.sub, false);
        lockHow.setPadding(dp(4), dp(10), dp(4), 0);
        root.addView(lockHow);

        // --- always running
        u.section(root, "Always running");
        LinearLayout k = u.card(root);
        pillAlways = u.pill("…", Ui.State.OFF);
        u.row(k, "Always-on VPN", "Starts Melad at boot and keeps it on", pillAlways);
        ((View) pillAlways.getParent()).setOnClickListener(v -> open(Settings.ACTION_VPN_SETTINGS));
        pillLockdown = u.pill("…", Ui.State.OFF);
        u.row(k, "Block connections without VPN", "Keep this OFF. Melad only carries DNS, so this would cut your internet", pillLockdown);
        ((View) pillLockdown.getParent()).setOnClickListener(v -> open(Settings.ACTION_VPN_SETTINGS));
        pillBattery = u.pill("…", Ui.State.OFF);
        u.row(k, "Battery: unrestricted", "So Samsung never puts Melad to sleep", pillBattery);
        ((View) pillBattery.getParent()).setOnClickListener(v -> askBattery());
        pillAdmin = u.pill("…", Ui.State.OFF);
        u.row(k, "Device admin", "Stops Melad being removed by accident", pillAdmin);
        ((View) pillAdmin.getParent()).setOnClickListener(v -> toggleAdmin());
    }

    // ------------------------------------------------------------------ status

    private void refreshStatus() {
        Engine e = Engine.running;
        boolean dnsWanted = prefs.getBoolean("dns_on", false);
        boolean dnsActive = e != null && e.dnsRunning();
        boolean spoofWanted = prefs.getBoolean("spoof_on", false);
        boolean spoofActive = e != null && e.spoofer.active();
        int locks = Guard.readLocks(this).size();
        boolean lockActive = e != null && locks > 0;
        boolean lockdown = e != null && dnsActive && e.lockdown();

        if (dnsSwitch.isChecked() != dnsWanted) { quiet = true; dnsSwitch.setChecked(dnsWanted); quiet = false; }
        if (spoofSwitch.isChecked() != spoofWanted) { quiet = true; spoofSwitch.setChecked(spoofWanted); quiet = false; }

        // banner + chips
        List<String> active = new java.util.ArrayList<>();
        if (dnsActive) active.add("blocking trackers");
        if (spoofActive) active.add("faking location");
        if (lockActive) active.add("locking " + locks + " setting" + (locks == 1 ? "" : "s"));
        if (lockdown) {
            u.setBanner(banner, "Internet is blocked", "\"Block connections without VPN\" is on. Turn it off below.", Ui.State.BAD);
        } else if (!active.isEmpty()) {
            u.setBanner(banner, "Protected", "Melad is " + String.join(", ", active) + ".", Ui.State.ON);
        } else if (dnsWanted || spoofWanted || locks > 0) {
            u.setBanner(banner, "Starting…", "", Ui.State.WARN);
        } else {
            u.setBanner(banner, "Off", "Nothing is being blocked or changed.", Ui.State.OFF);
        }
        u.setPill(chipBlock, dnsActive ? "● Blocking on" : "Blocking off", dnsActive ? Ui.State.ON : Ui.State.OFF);
        u.setPill(chipLoc, spoofActive ? "● Location faked" : "Location real", spoofActive ? Ui.State.ON : Ui.State.OFF);
        u.setPill(chipLock, lockActive ? "● " + locks + " locked" : "Nothing locked", lockActive ? Ui.State.ON : Ui.State.OFF);
        lockdownNotice.setText("Your internet is cut because Android's \"Block connections without VPN\" is on. "
                + "Melad only carries DNS (that's what keeps it light on battery), so Android blocks everything else. "
                + "Always-on alone already keeps Melad running all day. Tap here → gear next to Melad → turn that option off.");
        lockdownNotice.setVisibility(lockdown ? View.VISIBLE : View.GONE);

        // blocking
        if (dnsActive) {
            Blocklist l = e.list;
            dnsSub.setText(String.format(Locale.ROOT, "On · %,d domains blocked · DNS via %s",
                    l == null ? 0 : l.block.length, e.upstreamText));
        } else dnsSub.setText(dnsWanted ? "Starting…" : "Off");
        String warn = e == null ? "" : e.warning;
        dnsWarn.setText(warn);
        dnsWarn.setVisibility(dnsActive && !warn.isEmpty() ? View.VISIBLE : View.GONE);

        long when = Updater.lastUpdate(this);
        listsSub.setText("Once a day on Wi-Fi · " + (when == 0 ? "using the copy built into the app"
                : "last updated " + android.text.format.DateUtils.getRelativeTimeSpanString(when)));

        // location
        if (spoofActive) spoofSub.setText("On · apps see " + prefs.getString("lat", "") + ", " + prefs.getString("lon", ""));
        else if (!Spoofer.error.isEmpty()) spoofSub.setText(Spoofer.error);
        else spoofSub.setText(spoofWanted ? "Starting…" : "Off · apps see your real location");

        // settings lock
        boolean secure = checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
        boolean system = Settings.System.canWrite(this);
        permSub.setText((secure ? "✓ Can lock all settings" : "✗ Most settings need the one-time adb step (see README)")
                + (system ? "" : "\n✗ Time/date settings need \"Allow system settings\""));
        if (e != null && e.guard.reverts > 0) lockSub.setText(e.guard.reverts + " · last: " + e.guard.lastEvent);
        else if (e != null && !e.guard.lastError.isEmpty()) lockSub.setText("Problem: " + e.guard.lastError);
        else lockSub.setText(locks > 0 ? "None yet · watching" : "Nothing locked");

        // always running
        if (dnsActive) {
            boolean ao = e.alwaysOn();
            u.setPill(pillAlways, ao ? "On" : "Off · tap", ao ? Ui.State.ON : Ui.State.WARN);
            u.setPill(pillLockdown, lockdown ? "On · turn off" : "Off ✓", lockdown ? Ui.State.BAD : Ui.State.ON);
        } else {
            u.setPill(pillAlways, "Turn on blocking first", Ui.State.OFF);
            u.setPill(pillLockdown, "—", Ui.State.OFF);
        }
        boolean batt = getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
        u.setPill(pillBattery, batt ? "Unrestricted" : "Restricted · tap", batt ? Ui.State.ON : Ui.State.WARN);
        boolean admin = getSystemService(DevicePolicyManager.class).isAdminActive(new ComponentName(this, Receivers.Admin.class));
        u.setPill(pillAdmin, admin ? "On" : "Off", admin ? Ui.State.ON : Ui.State.OFF);
    }

    /** Settings values in words instead of raw 0/1. */
    static String human(String id, String v) {
        if (v == null) return "not set";
        if (id.endsWith("time_12_24")) return "24".equals(v) ? "24-hour" : "12".equals(v) ? "12-hour" : v;
        if (id.endsWith("date_format")) return v.isEmpty() ? "phone default" : v;
        if ("1".equals(v)) return "On";
        if ("0".equals(v)) return "Off";
        return v;
    }

    private void rebuildLocks() {
        lockList.removeAllViews();
        Map<String, String> locks = Guard.readLocks(this);
        java.util.LinkedHashMap<String, String> all = new java.util.LinkedHashMap<>();
        for (String[] s : Guard.SUGGESTED) all.put(s[0], s[1]);
        for (String k : locks.keySet()) if (!all.containsKey(k)) all.put(k, k);
        for (Map.Entry<String, String> en : all.entrySet()) {
            final String id = en.getKey();
            String now = Guard.get(getContentResolver(), id);
            boolean isLocked = locks.containsKey(id);
            Switch sw = u.toggle(isLocked);
            String sub;
            if (isLocked) sub = "Locked at " + human(id, locks.get(id)) + (now != null && !now.equals(locks.get(id)) ? " · now " + human(id, now) : "");
            else if (now == null) { sub = "Not available on this phone"; sw.setEnabled(false); }
            else sub = "Now " + human(id, now) + " · not locked";
            sw.setOnCheckedChangeListener((v, on) -> {
                Map<String, String> m = Guard.readLocks(this);
                String cur = Guard.get(getContentResolver(), id);
                if (on) {
                    if (cur == null) { toast("That setting doesn't exist on this phone"); return; }
                    m.put(id, cur);
                } else {
                    m.remove(id);
                }
                Guard.writeLocks(this, m);
                Engine.sync(this);
                ui.post(this::rebuildLocks);
            });
            u.row(lockList, en.getValue(), sub, sw);
        }
    }

    // ------------------------------------------------------------------ actions

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_VPN) {
            boolean ok = res == RESULT_OK;
            prefs.edit().putBoolean("dns_on", ok).apply();
            dnsSwitch.setChecked(ok);
            if (ok) Engine.sync(this);
        } else if (req == REQ_IMPORT && res == RESULT_OK && data != null && data.getData() != null) {
            importFile(data.getData());
        } else if (req == REQ_MAP && res == RESULT_OK && data != null) {
            lat.setText(String.format(Locale.ROOT, "%.6f", data.getDoubleExtra(MapActivity.EXTRA_LAT, 0)));
            lon.setText(String.format(Locale.ROOT, "%.6f", data.getDoubleExtra(MapActivity.EXTRA_LON, 0)));
            if (saveSpot()) Engine.sync(this);
        }
    }

    private boolean saveSpot() {
        double a = parse(lat, Double.NaN), o = parse(lon, Double.NaN);
        if (Double.isNaN(a) || Double.isNaN(o) || Math.abs(a) > 90 || Math.abs(o) > 180) {
            toast("Enter a latitude and longitude, or pick on the map");
            return false;
        }
        prefs.edit().putString("lat", Double.toString(a)).putString("lon", Double.toString(o)).apply();
        return true;
    }

    private void recompile() {
        new Thread(() -> {
            String msg;
            try {
                msg = String.format(Locale.ROOT, "Lists rebuilt: %,d rules", Store.compile(this));
                Engine e = Engine.running;
                if (e != null) e.reloadLists();
            } catch (Exception ex) {
                msg = "Rebuild failed: " + ex.getMessage();
            }
            final String m = msg;
            ui.post(() -> toast(m));
        }).start();
    }

    private void restartDns() {
        if (!prefs.getBoolean("dns_on", false)) return;
        prefs.edit().putBoolean("dns_on", false).apply();
        Engine.sync(this);
        ui.postDelayed(() -> { prefs.edit().putBoolean("dns_on", true).apply(); Engine.sync(this); }, 500);
    }

    /** Downloads one source that has no bundled copy, then rebuilds. */
    private void downloadThen(Store.Source s) {
        toast("Downloading " + s.label + "…");
        new Thread(() -> {
            String msg;
            try {
                int n = Updater.fetch(s.url, Store.cacheFile(this, s));
                msg = s.label + ": " + String.format(Locale.ROOT, "%,d", n) + " rules";
            } catch (Exception ex) {
                msg = "Download failed: " + ex.getMessage();
            }
            final String m = msg;
            ui.post(() -> { toast(m); recompile(); });
        }).start();
    }

    private void updateLists() {
        toast("Updating lists…");
        new Thread(() -> {
            String summary = Updater.updateAll(this, null);
            ui.post(() -> toast(summary));
        }).start();
    }

    private void pickImport() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        startActivityForResult(i, REQ_IMPORT);
    }

    private void importFile(Uri uri) {
        new Thread(() -> {
            File f = new File(Store.importsDir(this), System.currentTimeMillis() + ".txt");
            try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[65536];
                for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
            } catch (Exception e) {
                f.delete();
                ui.post(() -> toast("Import failed: " + e.getMessage()));
                return;
            }
            ui.post(this::recompile);
        }).start();
    }

    private void clearImports() {
        File[] fs = Store.importsDir(this).listFiles();
        if (fs != null) for (File f : fs) f.delete();
        recompile();
    }

    private void editLists() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), 0, dp(16), 0);
        box.addView(small("Blocked (one domain per line, subdomains included):"));
        EditText block = multi(prefs.getString("user_block", ""));
        box.addView(block);
        box.addView(small("Always allowed (wins over every list):"));
        EditText allow = multi(prefs.getString("user_allow", ""));
        box.addView(allow);
        ScrollView sv = new ScrollView(this);
        sv.addView(box);
        new AlertDialog.Builder(this).setTitle("My lists").setView(sv)
                .setPositiveButton("Save", (d, w) -> {
                    prefs.edit().putString("user_block", block.getText().toString())
                            .putString("user_allow", allow.getText().toString()).apply();
                    recompile();
                })
                .setNeutralButton("Clear imported files", (d, w) -> clearImports())
                .setNegativeButton("Cancel", null).show();
    }

    private void showLog() {
        Engine e = Engine.running;
        if (e == null) { toast("Turn blocking on first"); return; }
        List<Object[]> items = e.log.snapshot();
        if (items.isEmpty()) { toast("Nothing looked up yet"); return; }
        String[] labels = new String[items.size()];
        for (int i = 0; i < labels.length; i++) {
            Object[] it = items.get(i);
            labels[i] = ((Long) it[2] == 1 ? "⛔ " : "✓ ") + it[0] + "  ×" + it[1];
        }
        new AlertDialog.Builder(this).setTitle("Recent lookups (tap to block/allow)")
                .setItems(labels, (d, which) -> {
                    String name = (String) items.get(which)[0];
                    boolean isBlocked = (Long) items.get(which)[2] == 1;
                    addToList(isBlocked ? "user_allow" : "user_block", name);
                    toast((isBlocked ? "Allowed " : "Blocked ") + name);
                })
                .setNegativeButton("Close", null).show();
    }

    private void addToList(String key, String name) {
        String cur = prefs.getString(key, "");
        prefs.edit().putString(key, cur + (cur.isEmpty() || cur.endsWith("\n") ? "" : "\n") + name + "\n").apply();
        recompile();
    }

    private void addCustomLock() {
        EditText in = new EditText(this);
        in.setHint("global:auto_time=0   or   system:time_12_24");
        in.setSingleLine();
        new AlertDialog.Builder(this).setTitle("Lock a setting")
                .setMessage("table:key to keep the current value, or table:key=value to set and keep it. Tables: global, secure, system.")
                .setView(in)
                .setPositiveButton("Lock", (d, w) -> {
                    String s = in.getText().toString().trim();
                    int eq = s.indexOf('=');
                    String id = eq > 0 ? s.substring(0, eq).trim() : s;
                    if (!id.matches("(global|secure|system):[A-Za-z0-9_.]+")) { toast("Format: global:key"); return; }
                    String val = eq > 0 ? s.substring(eq + 1).trim() : Guard.get(getContentResolver(), id);
                    if (val == null) { toast("No such setting; give a value with ="); return; }
                    String err = Guard.put(getContentResolver(), id, val);
                    if (err != null) toast("Saved, but can't write yet: " + err);
                    Map<String, String> m = Guard.readLocks(this);
                    m.put(id, val);
                    Guard.writeLocks(this, m);
                    Engine.sync(this);
                    rebuildLocks();
                })
                .setNegativeButton("Cancel", null).show();
    }

    private void editUpstream() {
        EditText in = new EditText(this);
        in.setHint("empty = your network's own DNS");
        in.setText(prefs.getString("upstream", ""));
        in.setSingleLine();
        new AlertDialog.Builder(this).setTitle("Upstream DNS")
                .setMessage("Where allowed lookups go. Leave empty to use the DNS your Wi-Fi or carrier gives you "
                        + "(no third party). Or enter IPs, e.g. 9.9.9.9, 149.112.112.112")
                .setView(in)
                .setPositiveButton("Save", (d, w) -> {
                    prefs.edit().putString("upstream", in.getText().toString().trim()).apply();
                    restartDns();
                })
                .setNegativeButton("Cancel", null).show();
    }

    private void askBattery() {
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
            open(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            toast("Already unrestricted");
            return;
        }
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            open(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        }
    }

    private void toggleAdmin() {
        DevicePolicyManager dpm = getSystemService(DevicePolicyManager.class);
        ComponentName admin = new ComponentName(this, Receivers.Admin.class);
        if (dpm.isAdminActive(admin)) {
            new AlertDialog.Builder(this).setMessage("Remove Melad as device admin?")
                    .setPositiveButton("Remove", (d, w) -> dpm.removeActiveAdmin(admin))
                    .setNegativeButton("Keep", null).show();
        } else {
            startActivity(new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
                    .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Protects Melad from being removed or disabled by accident."));
        }
    }

    // ------------------------------------------------------------------ view helpers

    private void open(String action) { open(action, false); }

    private void open(String action, boolean withPackage) {
        Intent i = new Intent(action);
        if (withPackage) i.setData(Uri.parse("package:" + getPackageName()));
        try { startActivity(i); } catch (RuntimeException e) { toast("This phone has no such settings screen"); }
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        return t;
    }

    /** A filled shape with rounded corners, for the status banner. */
    private android.graphics.drawable.GradientDrawable rounded(int color) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(16));
        return g;
    }

    private TextView big(String s, int sp) {
        TextView t = text(s, sp);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView small(String s) {
        TextView t = text(s, 13);
        t.setAlpha(0.75f);
        t.setPadding(0, dp(2), 0, dp(6));
        return t;
    }

    private void header(String s) {
        TextView t = text(s, 18);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(24), 0, dp(6));
        root.addView(t);
    }

    private CheckBox check(String s, boolean on) {
        CheckBox c = new CheckBox(this);
        c.setText(s);
        c.setChecked(on);
        return c;
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private void row(View a, View b) {
        LinearLayout l = new LinearLayout(this);
        l.addView(a, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        l.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(l);
    }

    private EditText number(String v, String hint) {
        EditText e = new EditText(this);
        e.setText(v);
        e.setHint(hint);
        e.setSingleLine();
        e.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED);
        return e;
    }

    private EditText multi(String v) {
        EditText e = new EditText(this);
        e.setText(v);
        e.setMinLines(4);
        e.setTextSize(13);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        return e;
    }

    private static double parse(EditText e, double fallback) {
        try { return Double.parseDouble(e.getText().toString().trim()); } catch (NumberFormatException x) { return fallback; }
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}

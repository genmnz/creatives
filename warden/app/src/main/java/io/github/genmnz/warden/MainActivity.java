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
    private TextView status, guardStatus, spoofStatus, permStatus;
    private Switch dnsSwitch;
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
        prefs = Store.prefs(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, dp(48));
        ScrollView sv = new ScrollView(this);
        sv.setFitsSystemWindows(true);
        sv.addView(root);
        setContentView(sv);
        build();
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
        root.addView(small("Telemetry & location blocker. Everything runs on this phone; no Warden servers exist."));

        // --- protection
        header("Blocking");
        dnsSwitch = new Switch(this);
        dnsSwitch.setText("Block telemetry & trackers (local DNS filter)");
        dnsSwitch.setTextSize(16);
        dnsSwitch.setChecked(prefs.getBoolean("dns_on", false));
        dnsSwitch.setOnCheckedChangeListener((v, on) -> {
            if (quiet) return;
            if (on) {
                Intent i = VpnService.prepare(this);
                if (i != null) { startActivityForResult(i, REQ_VPN); return; }
            }
            prefs.edit().putBoolean("dns_on", on).apply();
            Engine.sync(this);
        });
        root.addView(dnsSwitch);
        status = small("");
        root.addView(status);

        for (String[] cat : Store.CATEGORIES) {
            CheckBox cb = check(cat[1], prefs.getBoolean("cat_" + cat[0], true));
            cb.setOnCheckedChangeListener((v, on) -> {
                prefs.edit().putBoolean("cat_" + cat[0], on).apply();
                recompile();
            });
            root.addView(cb);
            TextView d = small(cat[2]);
            d.setPadding(dp(32), 0, 0, dp(4));
            root.addView(d);
        }
        CheckBox hard = check("Catch apps that hardcode Google/Cloudflare/Quad9 DNS", prefs.getBoolean("catch_hardcoded", true));
        hard.setOnCheckedChangeListener((v, on) -> { prefs.edit().putBoolean("catch_hardcoded", on).apply(); restartDns(); });
        root.addView(hard);

        row(button("Recent lookups", v -> showLog()),
                button("Import list file", v -> pickImport()));
        row(button("Edit my lists", v -> editLists()),
                button("Clear imports", v -> clearImports()));

        // --- location
        header("Location");
        Switch spoof = new Switch(this);
        spoof.setText("Report my marked spot as the phone's location");
        spoof.setTextSize(16);
        spoof.setChecked(prefs.getBoolean("spoof_on", false));
        root.addView(spoof);
        LinearLayout ll = new LinearLayout(this);
        lat = number(prefs.getString("lat", ""), "Latitude");
        lon = number(prefs.getString("lon", ""), "Longitude");
        ll.addView(lat, new LinearLayout.LayoutParams(0, -2, 1));
        ll.addView(lon, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(ll);
        spoof.setOnCheckedChangeListener((v, on) -> {
            if (on && !saveSpot()) { v.setChecked(false); return; }
            prefs.edit().putBoolean("spoof_on", on).apply();
            Engine.sync(this);
        });
        row(button("Pick on map", v -> {
                    Intent i = new Intent(this, MapActivity.class)
                            .putExtra(MapActivity.EXTRA_LAT, parse(lat, 0)).putExtra(MapActivity.EXTRA_LON, parse(lon, 0));
                    startActivityForResult(i, REQ_MAP);
                }),
                button("Mock app setting", v -> open(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)));
        spoofStatus = small("");
        root.addView(spoofStatus);
        root.addView(small("One-time setup: Developer options → Select mock location app → Warden. "
                + "Wi-Fi/Bluetooth scanning and A-GPS can be switched off below in Settings lock."));

        // --- settings lock
        header("Settings lock (SIM / carrier changes)");
        root.addView(small("Tick a setting to keep its current value. When a SIM, eSIM or carrier update changes it, "
                + "Warden puts it back right away. Set things the way you like in Settings first, then tick."));
        permStatus = small("");
        root.addView(permStatus);
        lockList = new LinearLayout(this);
        lockList.setOrientation(LinearLayout.VERTICAL);
        root.addView(lockList);
        row(button("Lock other key", v -> addCustomLock()),
                button("Allow system settings", v -> open(Settings.ACTION_MANAGE_WRITE_SETTINGS, true)));
        guardStatus = small("");
        root.addView(guardStatus);

        // --- staying alive
        header("Keep running");
        root.addView(small("For all-day protection: turn on Always-on VPN for Warden, and let it ignore battery "
                + "optimisation (Samsung otherwise puts it to sleep). Device admin stops accidental removal."));
        row(button("Always-on VPN", v -> open(Settings.ACTION_VPN_SETTINGS)),
                button("Battery: unrestricted", v -> askBattery()));
        row(button("Device admin", v -> toggleAdmin()),
                button("Upstream DNS", v -> editUpstream()));
    }

    // ------------------------------------------------------------------ status

    private void refreshStatus() {
        Engine e = Engine.running;
        StringBuilder s = new StringBuilder();
        if (e != null && e.dnsRunning()) {
            Blocklist l = e.list;
            s.append(String.format(Locale.ROOT, "Active · %,d rules · DNS via %s\n%,d lookups, %,d blocked, %,d from cache",
                    l == null ? 0 : l.block.length, e.upstreamText, e.queries.get(), e.blocked.get(), e.cached.get()));
            if (!e.warning.isEmpty()) s.append("\n⚠ ").append(e.warning);
        } else {
            s.append(prefs.getBoolean("dns_on", false) ? "Starting…" : "Off");
        }
        status.setText(s);
        boolean on = prefs.getBoolean("dns_on", false);
        if (dnsSwitch.isChecked() != on) { quiet = true; dnsSwitch.setChecked(on); quiet = false; }

        boolean secure = checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
        boolean system = Settings.System.canWrite(this);
        permStatus.setText((secure ? "✓ Can lock Global/Secure settings" :
                "✗ Global/Secure locks need a one-time adb command (see README): adb shell pm grant "
                        + getPackageName() + " android.permission.WRITE_SECURE_SETTINGS")
                + "\n" + (system ? "✓ Can lock System settings" : "✗ System locks need 'Allow system settings'"));

        if (e != null) {
            guardStatus.setText("Reverted " + e.guard.reverts + " change(s)"
                    + (e.guard.lastEvent.isEmpty() ? "" : "\nLast: " + e.guard.lastEvent)
                    + (e.guard.lastError.isEmpty() ? "" : "\nProblem: " + e.guard.lastError));
            spoofStatus.setText(e.spoofer.active() ? "Reporting marked spot" : Spoofer.error);
        } else {
            guardStatus.setText(Guard.readLocks(this).isEmpty() ? "" : "Not running");
            spoofStatus.setText(Spoofer.error);
        }
    }

    private void rebuildLocks() {
        lockList.removeAllViews();
        Map<String, String> locks = Guard.readLocks(this);
        java.util.LinkedHashMap<String, String> all = new java.util.LinkedHashMap<>();
        for (String[] s : Guard.SUGGESTED) all.put(s[0], s[1]);
        for (String k : locks.keySet()) if (!all.containsKey(k)) all.put(k, "custom");
        for (Map.Entry<String, String> en : all.entrySet()) {
            final String id = en.getKey();
            String now = Guard.get(getContentResolver(), id);
            boolean isLocked = locks.containsKey(id);
            String label = en.getValue() + "\n" + id + " = " + (isLocked ? locks.get(id) + " (locked)" : now);
            CheckBox cb = check(label, isLocked);
            cb.setTextSize(13);
            cb.setOnCheckedChangeListener((v, on) -> {
                Map<String, String> m = Guard.readLocks(this);
                String cur = Guard.get(getContentResolver(), id);
                if (on) {
                    if (cur == null) { toast("That setting doesn't exist on this phone"); v.setChecked(false); return; }
                    m.put(id, cur);
                } else {
                    m.remove(id);
                }
                Guard.writeLocks(this, m);
                Engine.sync(this);
                rebuildLocks();
            });
            lockList.addView(cb);
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
            new AlertDialog.Builder(this).setMessage("Remove Warden as device admin?")
                    .setPositiveButton("Remove", (d, w) -> dpm.removeActiveAdmin(admin))
                    .setNegativeButton("Keep", null).show();
        } else {
            startActivity(new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
                    .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Protects Warden from being removed or disabled by accident."));
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

package io.github.genmnz.warden;

import android.content.ContentResolver;
import android.content.Context;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.Handler;
import android.provider.Settings;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Settings lock. Keeps chosen system settings at the value you picked and puts
 * them back the moment anything (SIM/carrier customisation, NITZ, OMC agent)
 * changes them. Purely event driven: one ContentObserver per locked key.
 *
 * Global/Secure keys need WRITE_SECURE_SETTINGS (granted once over adb),
 * System keys need the "Modify system settings" permission.
 */
final class Guard {
    /** Keys worth locking, shown in the UI with their current value. */
    static final String[][] SUGGESTED = {
            {"global:auto_time", "Automatic date & time"},
            {"global:auto_time_zone", "Automatic time zone"},
            {"system:time_12_24", "Clock format"},
            {"system:date_format", "Date format"},
            {"global:data_roaming", "Data roaming"},
            {"global:wifi_scan_always_enabled", "Wi-Fi scanning (for location)"},
            {"global:ble_scan_always_enabled", "Bluetooth scanning (for location)"},
            {"global:assisted_gps_enabled", "Assisted GPS"},
            {"global:mobile_data_always_on", "Mobile data always active"},
            {"global:network_recommendations_enabled", "Network recommendations"},
    };

    private final Context ctx;
    private final Handler handler;
    private final ContentResolver cr;
    private final List<ContentObserver> observers = new ArrayList<>();
    /** "table:key" -> locked value */
    private final Map<String, String> locked = new LinkedHashMap<>();
    volatile int reverts;
    volatile String lastEvent = "";
    volatile String lastError = "";

    Guard(Context ctx, Handler handler) {
        this.ctx = ctx;
        this.handler = handler;
        this.cr = ctx.getContentResolver();
    }

    // ---- lock storage: lines of "table:key=value" ----

    static Map<String, String> readLocks(Context c) {
        Map<String, String> m = new LinkedHashMap<>();
        for (String line : Store.prefs(c).getString("locks", "").split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) m.put(line.substring(0, eq), line.substring(eq + 1));
        }
        return m;
    }

    static void writeLocks(Context c, Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : m.entrySet()) sb.append(e.getKey()).append('=').append(e.getValue()).append('\n');
        Store.prefs(c).edit().putString("locks", sb.toString()).apply();
    }

    // ---- raw settings access ----

    static String get(ContentResolver cr, String id) {
        int colon = id.indexOf(':');
        if (colon < 0) return null;
        String table = id.substring(0, colon), key = id.substring(colon + 1);
        try {
            switch (table) {
                case "global": return Settings.Global.getString(cr, key);
                case "secure": return Settings.Secure.getString(cr, key);
                case "system": return Settings.System.getString(cr, key);
            }
        } catch (RuntimeException ignored) {
        }
        return null;
    }

    /** Returns null on success, else a short reason. */
    static String put(ContentResolver cr, String id, String value) {
        int colon = id.indexOf(':');
        if (colon < 0) return "bad key";
        String table = id.substring(0, colon), key = id.substring(colon + 1);
        try {
            boolean ok;
            switch (table) {
                case "global": ok = Settings.Global.putString(cr, key, value); break;
                case "secure": ok = Settings.Secure.putString(cr, key, value); break;
                case "system": ok = Settings.System.putString(cr, key, value); break;
                default: return "unknown table " + table;
            }
            return ok ? null : "write refused";
        } catch (SecurityException e) {
            return table.equals("system") ? "needs 'Modify system settings'" : "needs WRITE_SECURE_SETTINGS (adb)";
        } catch (RuntimeException e) {
            return String.valueOf(e.getMessage());
        }
    }

    private static Uri uri(String id) {
        int colon = id.indexOf(':');
        String table = id.substring(0, colon), key = id.substring(colon + 1);
        switch (table) {
            case "global": return Settings.Global.getUriFor(key);
            case "secure": return Settings.Secure.getUriFor(key);
            default: return Settings.System.getUriFor(key);
        }
    }

    // ---- runtime ----

    void start() {
        stop();
        locked.putAll(readLocks(ctx));
        for (final String id : locked.keySet()) {
            ContentObserver o = new ContentObserver(handler) {
                @Override public void onChange(boolean selfChange) { enforce(id); }
            };
            try {
                cr.registerContentObserver(uri(id), false, o);
                observers.add(o);
            } catch (RuntimeException ignored) {
            }
        }
        enforceAll();
    }

    void stop() {
        for (ContentObserver o : observers) cr.unregisterContentObserver(o);
        observers.clear();
        locked.clear();
    }

    void enforceAll() {
        for (String id : locked.keySet()) enforce(id);
    }

    /** SIM/carrier customisation applies settings over a few minutes; re-check a few times. */
    void burst() {
        long[] delays = {2_000, 15_000, 60_000, 180_000};
        for (long d : delays) handler.postDelayed(this::enforceAll, d);
    }

    private void enforce(String id) {
        String want = locked.get(id);
        if (want == null) return;
        String now = get(cr, id);
        if (want.equals(now)) return;
        String err = put(cr, id, want);
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
        if (err == null) {
            reverts++;
            lastEvent = time + "  " + id + ": " + now + " → " + want;
        } else {
            lastError = time + "  " + id + ": " + err;
        }
    }
}

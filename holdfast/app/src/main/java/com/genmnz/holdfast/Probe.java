package com.genmnz.holdfast;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.telephony.TelephonyManager;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Locale;
import java.util.TimeZone;

/** Read-only device facts for the diagnostics report. Never changes anything. Off the main thread only. */
final class Probe {
    static final String PATCH_FLOOR = "2026-05-01";

    private Probe() {}

    /** getprop as the app; falls back to the shell if SELinux hides it from apps. */
    static String prop(Context c, String key) {
        String v = "";
        try {
            Process p = new ProcessBuilder("getprop", key).redirectErrorStream(true).start();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line = r.readLine();
                v = line == null ? "" : line.trim();
            }
            p.waitFor();
        } catch (Exception ignored) {
        }
        if (v.isEmpty() && Shell.permitted()) {
            try {
                String s = Shell.run(c, "getprop " + key).out.trim();
                if (!s.isEmpty()) return s + " (via shell)";
            } catch (Exception ignored) {
            }
        }
        return v.isEmpty() ? "(empty or hidden from apps)" : v;
    }

    static String patchVerdict() {
        String p = Build.VERSION.SECURITY_PATCH;
        if (p == null || p.isEmpty()) return "unknown";
        return p + (p.compareTo(PATCH_FLOOR) >= 0 ? "  OK (CVE-2026-0073 wireless-ADB fix included)"
                : "  OLD: before " + PATCH_FLOOR + ", keep wireless debugging off (CVE-2026-0073)");
    }

    static String report(Context c) {
        StringBuilder r = new StringBuilder();
        Privs pv = Privs.now(c);
        r.append("Holdfast ").append(BuildConfig.VERSION_NAME).append(" diagnostics · ").append(EventLog.now()).append("\n");

        r.append("\n== Device ==\n");
        r.append("Model: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append(" (").append(Build.DEVICE).append(")\n");
        r.append("Android: ").append(Build.VERSION.RELEASE).append(" · SDK ").append(Build.VERSION.SDK_INT).append("\n");
        r.append("One UI: ").append(prop(c, "ro.build.version.oneui")).append("\n");
        r.append("Build: ").append(Build.DISPLAY).append("\n");
        r.append("Security patch: ").append(patchVerdict()).append("\n");

        r.append("\n== Privileges ==\n");
        r.append("Device Owner: ").append(pv.deviceOwner ? "yes" : "no").append("\n");
        r.append("WRITE_SECURE_SETTINGS: ").append(pv.secure ? "granted" : "not granted").append("\n");
        r.append("Modify system settings: ").append(pv.system ? "allowed" : "not allowed").append("\n");
        r.append("Shizuku: ").append(Shell.describe()).append("\n");
        r.append("Notifications: ").append(c.getSystemService(NotificationManager.class).areNotificationsEnabled() ? "allowed" : "blocked").append("\n");
        r.append("Watchdog: ").append(WatchJob.status(c)).append("\n");
        r.append("USB debugging (adb_enabled): ").append(Sx.get(c, Sx.GLOBAL, "adb_enabled"))
                .append("  (Android 17 QPR1+ reports 0 to apps whatever it is)\n");
        r.append("Wireless debugging (adb_wifi_enabled): ").append(Sx.get(c, Sx.GLOBAL, "adb_wifi_enabled")).append("\n");

        r.append("\n== Where Android thinks you are ==\n");
        TelephonyManager tm = c.getSystemService(TelephonyManager.class);
        r.append("1. Network country (cell MCC): ").append(nz(tm.getNetworkCountryIso()))
                .append("   ← checked first by Android's country detector; comes from the radio, not changeable\n");
        r.append("2. Location-based country: ").append(c.getSystemService(android.location.LocationManager.class).isLocationEnabled()
                ? "location is ON, so available" : "location off, so unavailable").append("\n");
        r.append("3. SIM country: ").append(nz(tm.getSimCountryIso())).append("\n");
        r.append("4. Phone locale: ").append(Locale.getDefault().toLanguageTag()).append("\n");
        r.append("Time zone: ").append(TimeZone.getDefault().getID())
                .append(" · auto: ").append(Sx.get(c, Sx.GLOBAL, "auto_time_zone")).append("\n");
        r.append("Network operator: ").append(nz(tm.getNetworkOperatorName())).append(" (").append(nz(tm.getNetworkOperator())).append(")\n");
        r.append("Not visible on the phone: your public IP, which ad platforms use first.\n");

        r.append("\n== Samsung region (read-only) ==\n");
        r.append("CSC (ro.csc.sales_code): ").append(prop(c, "ro.csc.sales_code")).append("\n");
        r.append("CSC country (ro.csc.country_code): ").append(prop(c, "ro.csc.country_code")).append("\n");
        r.append("Bootloader region (ro.boot.sales_code): ").append(prop(c, "ro.boot.sales_code")).append("\n");
        String change = prop(c, "ro.omc.changetype");
        r.append("CSC change type (ro.omc.changetype): ").append(change).append("\n");
        if (change.contains("DATA_RESET_ON"))
            r.append("  → changing CSC on this firmware WIPES the phone. Only CSCs in the firmware bundle can be chosen.\n");
        r.append("Bundled CSCs: ");
        if (Shell.permitted()) {
            try {
                String ls = Shell.run(c, "ls /optics/configs/carriers 2>/dev/null").out.trim().replace("\n", " ");
                r.append(ls.isEmpty() ? "(not listed at /optics/configs/carriers)" : ls);
            } catch (Exception e) {
                r.append("(shell error: ").append(e.getMessage()).append(")");
            }
        } else r.append("(needs Shizuku to list)");
        r.append("\nCSC is changed from a PC or a second phone (Test Mode AT commands), not from this app.\n");

        r.append("\n== Controls ==\n");
        r.append("[mark] title · now → wanted · hold · last action · drifts · original\n");
        for (Control ctl : Controls.all(c)) {
            Control.State s = ctl.read(c);
            r.append("[").append(Ui.stateMark(s.ok)).append("] ").append(ctl.title).append(" (").append(ctl.id).append(")\n");
            r.append("    now: ").append(s.value).append("  ·  wanted: ").append(ctl.want).append("\n");
            if (ctl.paramPrompt != null) r.append("    your value: ").append(nz(ctl.param(c))).append("\n");
            boolean held = Store.isHeld(c, ctl.id);
            r.append("    held: ").append(held ? Store.mode(c, ctl.id) + " via " + Store.path(c, ctl.id) : "no").append("\n");
            Step best = Enforcer.pick(c, ctl);
            r.append("    can apply now via: ").append(best == null ? "nothing held (needs " + ControlUi.needs(ctl.apply(c)) + ")"
                    : best.tier.label + " — " + best.lines[0]).append("\n");
            String last = Store.last(c, ctl.id);
            if (last != null) r.append("    last: ").append(last).append("\n");
            int d = Store.drifts(c, ctl.id);
            if (d > 0) r.append("    changed back ").append(d).append("×, last ").append(Store.driftAt(c, ctl.id)).append("\n");
            String o = Store.original(c, ctl.id);
            if (o != null) r.append("    before Holdfast: ").append(o).append("\n");
        }

        r.append("\n== Done by you (self-reported) ==\n");
        for (String[] m : MainActivity.MANUAL)
            r.append("[").append(Store.manual(c, m[0]) ? "x" : " ").append("] ").append(m[1]).append("\n");

        r.append("\n== Recent events ==\n").append(EventLog.tail(c, 24_000));
        return r.toString();
    }

    private static String nz(String s) {
        return s == null || s.isEmpty() ? "(none)" : s;
    }
}

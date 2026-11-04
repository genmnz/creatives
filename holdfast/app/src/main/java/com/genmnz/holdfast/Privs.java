package com.genmnz.holdfast;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.provider.Settings;

/** Which tiers Holdfast holds right now. Cheap; re-read whenever you need it. */
final class Privs {
    final boolean deviceOwner, secure, system, shizuku;

    private Privs(boolean deviceOwner, boolean secure, boolean system, boolean shizuku) {
        this.deviceOwner = deviceOwner;
        this.secure = secure;
        this.system = system;
        this.shizuku = shizuku;
    }

    static Privs now(Context c) {
        DevicePolicyManager dpm = c.getSystemService(DevicePolicyManager.class);
        return new Privs(
                dpm != null && dpm.isDeviceOwnerApp(c.getPackageName()),
                c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED,
                Settings.System.canWrite(c),
                Shell.permitted());
    }

    boolean has(Tier t) {
        switch (t) {
            case DEVICE_OWNER: return deviceOwner;
            case SECURE_SETTINGS: return secure;
            case SYSTEM_SETTINGS: return system;
            case SHIZUKU: return shizuku;
        }
        return false;
    }

    static ComponentName admin(Context c) {
        return new ComponentName(c, AdminReceiver.class);
    }

    static DevicePolicyManager dpm(Context c) {
        return c.getSystemService(DevicePolicyManager.class);
    }

    String summary() {
        return mark(deviceOwner) + " Device Owner   " + mark(secure) + " Secure settings   "
                + mark(system) + " System settings   " + mark(shizuku) + " Shizuku";
    }

    private static String mark(boolean b) {
        return b ? "✓" : "✗";
    }
}

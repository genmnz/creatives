package io.github.genmnz.warden;

import android.app.admin.DeviceAdminReceiver;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Small receivers kept in one file. */
public final class Receivers {
    private Receivers() {}

    /** Brings the engine back after a reboot or an app update. */
    public static final class Boot extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            String a = i.getAction();
            if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) Engine.sync(c);
        }
    }

    /** Device admin: makes Warden harder to remove or force-stop by accident. */
    public static final class Admin extends DeviceAdminReceiver {
        @Override public CharSequence onDisableRequested(Context c, Intent i) {
            return "Melad stops being protected from removal. Blocking keeps running until you turn it off.";
        }
    }
}

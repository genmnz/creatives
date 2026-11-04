package com.genmnz.holdfast;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;

/** Needed for Device Owner: adb shell dpm set-device-owner com.genmnz.holdfast/.AdminReceiver */
public class AdminReceiver extends DeviceAdminReceiver {
    @Override
    public void onEnabled(Context c, Intent i) {
        EventLog.add(c, "PRIVILEGE", "-", "device admin enabled (Device Owner: " + Privs.now(c).deviceOwner + ")");
    }

    @Override
    public void onDisabled(Context c, Intent i) {
        EventLog.add(c, "PRIVILEGE", "-", "device admin disabled");
    }
}

package com.genmnz.holdfast;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Re-checks held controls after a reboot or an app update, and re-arms the watchers. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String what = Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction()) ? "app update" : "boot";
        PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                EventLog.add(c, "WAKE", "-", what + " · tiers: " + Privs.now(c).summary());
                Enforcer.check(c, what);
                WatchJob.schedule(c);
            } finally {
                pr.finish();
            }
        }).start();
    }
}

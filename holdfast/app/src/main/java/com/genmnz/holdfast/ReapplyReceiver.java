package com.genmnz.holdfast;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The notification's Re-apply button. Pressing it is the confirmation for the step it showed. */
public class ReapplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String id = i.getStringExtra("id");
        if (id == null) return;
        PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                Control ctl = Controls.byId(c, id);
                if (ctl == null) return;
                Step step = Enforcer.pick(c, ctl);
                if (step == null) return;
                Enforcer.notifyResult(c, ctl, Enforcer.run(c, ctl, step, false, "notification"));
            } finally {
                pr.finish();
            }
        }).start();
    }
}

package com.genmnz.holdfast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.List;

/**
 * Runs confirmed steps, verifies them by reading back, and checks held controls for drift.
 * Everything here blocks; never call it on the main thread.
 */
final class Enforcer {
    static final String CHANNEL = "drift";

    static final int WORKED = 0, FAILED = 1, DIDNT_TAKE = 2, UNSURE = 3;

    static final class Outcome {
        final boolean ok;
        final int kind;
        final String text;
        final String error;
        final Control.State after;

        Outcome(int kind, String text, String error, Control.State after) {
            this.ok = kind == WORKED;
            this.kind = kind;
            this.text = text;
            this.error = error;
            this.after = after;
        }
    }

    private Enforcer() {}

    /** Runs one step the user confirmed (directly, or by holding the control earlier). */
    static Outcome run(Context c, Control ctl, Step step, boolean restoring, String trigger) {
        if (!restoring) {
            try {
                Store.saveOriginal(c, ctl.id, ctl.snapshot(c));
            } catch (Exception ignored) {
            }
        }
        String verb = restoring ? "RESTORE" : "APPLY";
        String before = ctl.read(c).value;
        String output;
        try {
            if (!Privs.now(c).has(step.tier)) throw new Exception("Holdfast doesn't hold \"" + step.tier.label + "\" right now");
            output = step.action.run(c);
        } catch (Throwable e) {
            String msg = e.getMessage() == null ? e.toString() : e.getMessage();
            String text = "FAILED via " + step.tier.label + " (" + step.how + ")\n" + step.text() + "\n→ " + msg;
            EventLog.add(c, verb + "-FAIL", ctl.id, trigger + " · " + text);
            Store.last(c, ctl.id, verb.toLowerCase(java.util.Locale.ROOT) + " failed via " + step.tier.label + ": " + msg);
            return new Outcome(FAILED, text, msg, null);
        }
        Control.State after = ctl.read(c);
        if (!restoring && !Boolean.TRUE.equals(after.ok)) {
            // Some changes (telephony, time zone) land a moment later.
            try {
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {
            }
            after = ctl.read(c);
        }
        boolean ok;
        String verdict;
        if (restoring) {
            ok = true;
            verdict = "restored, now " + after.value;
        } else if (Boolean.TRUE.equals(after.ok)) {
            ok = true;
            verdict = "verified ✓ (" + before + " → " + after.value + ")";
        } else if (after.ok == null) {
            ok = false;
            verdict = "ran, but can't be verified (now: " + after.value + ")";
        } else {
            ok = false;
            verdict = "NOT verified ✗: the call was accepted but the value is still " + after.value
                    + ". Try another path.";
        }
        String text = "via " + step.tier.label + " (" + step.how + ")\n" + step.text() + "\n→ " + verdict
                + (output == null || output.trim().isEmpty() ? "" : "\nOutput:\n" + output.trim());
        EventLog.add(c, verb + (ok ? "" : "-UNVERIFIED"), ctl.id, trigger + " · " + text);
        Store.last(c, ctl.id, verb.toLowerCase(java.util.Locale.ROOT) + " via " + step.tier.label + ": " + verdict);
        return new Outcome(ok ? WORKED : after.ok == null ? UNSURE : DIDNT_TAKE, text, null, after);
    }

    /** The step the watchdog would use: the one the user confirmed when holding, else the strongest available. */
    static Step pick(Context c, Control ctl) {
        Privs p = Privs.now(c);
        List<Step> steps = ctl.apply(c);
        String want = Store.path(c, ctl.id);
        if (want != null) for (Step s : steps) if (s.key().equals(want) && p.has(s.tier)) return s;
        for (Step s : steps) if (p.has(s.tier)) return s;
        return null;
    }

    /** Looks at every held control. Fixes drift (auto mode) or asks with a notification (ask mode). */
    static void check(Context c, String trigger) {
        String fp = Build.FINGERPRINT;
        String oldFp = Store.p(c).getString("fingerprint", null);
        if (!fp.equals(oldFp)) {
            if (oldFp != null) EventLog.add(c, "SYSTEM-UPDATE", "-", "build changed: " + oldFp + " → " + fp + ". Checking everything.");
            Store.p(c).edit().putString("fingerprint", fp).apply();
        }
        for (String id : Store.held(c)) {
            Control ctl = Controls.byId(c, id);
            if (ctl == null || !ctl.present(c)) {
                EventLog.add(c, "SKIP", id, "held, but not present on this device any more");
                continue;
            }
            Control.State s = ctl.read(c);
            String seen = Store.p(c).getString("seen." + id, "");
            String now = s.ok == null ? "unknown" : s.ok ? "ok" : "drift";
            Store.p(c).edit().putString("seen." + id, now).apply();
            if (Boolean.TRUE.equals(s.ok)) {
                nm(c).cancel(id.hashCode());
                continue;
            }
            if (s.ok == null) {
                // Log once per change of state, not every 15 minutes.
                if (!"unknown".equals(seen)) EventLog.add(c, "UNKNOWN", id, "can't read state (" + s.value + ") on " + trigger);
                continue;
            }
            if (!"drift".equals(seen)) {
                // Count each time it goes from right to wrong, not each check while it stays wrong.
                Store.drift(c, id, s.value);
                EventLog.add(c, "DRIFT", id, "now " + s.value + ", want " + ctl.want + " · noticed on " + trigger);
            }
            Step step = pick(c, ctl);
            if (step == null) {
                notifyDrift(c, ctl, s, null, "No privilege tier available to fix it. Open Holdfast → Privileges.");
                continue;
            }
            if (Store.AUTO.equals(Store.mode(c, id))) {
                if (Store.allowAuto(c, id)) {
                    Outcome o = run(c, ctl, step, false, "auto (" + trigger + ")");
                    if (!o.ok) notifyDrift(c, ctl, s, step, "Automatic re-apply didn't stick.");
                    continue;
                }
                EventLog.add(c, "AUTO-PAUSED", id, "re-applied 3 times in 10 minutes; something keeps changing it. Asking instead.");
                notifyDrift(c, ctl, s, step, "Changed back 3 times in 10 minutes; auto-fix paused. Something keeps turning it on.");
                continue;
            }
            notifyDrift(c, ctl, s, step, null);
        }
    }

    static NotificationManager nm(Context c) {
        NotificationManager m = c.getSystemService(NotificationManager.class);
        if (m.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Setting changed back",
                    NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("A held setting drifted. The notification shows exactly what Re-apply would run.");
            m.createNotificationChannel(ch);
        }
        return m;
    }

    static void notifyDrift(Context c, Control ctl, Control.State s, Step step, String extra) {
        String body = "Something turned this back to \"" + ctl.human(s) + "\". Holdfast hasn't changed anything."
                + (extra == null ? "" : "\n" + extra)
                + (step == null ? "" : "\nFix it runs:\n" + step.text());
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(ctl.title + " was changed back")
                .setContentText("Tap Fix it to change it again.")
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE))
                .setOnlyAlertOnce(true);
        if (step != null) {
            Intent i = new Intent(c, ReapplyReceiver.class).putExtra("id", ctl.id).setAction("reapply:" + ctl.id);
            PendingIntent pi = PendingIntent.getBroadcast(c, ctl.id.hashCode(), i,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(new Notification.Action.Builder(null, "Fix it", pi).build());
        }
        try {
            nm(c).notify(ctl.id.hashCode(), b.build());
        } catch (Exception e) {
            EventLog.add(c, "NOTIFY-FAIL", ctl.id, String.valueOf(e));
        }
    }

    static void notifyResult(Context c, Control ctl, Outcome o) {
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(ctl.title + (o.ok ? ": fixed ✓" : ": couldn't fix it"))
                .setStyle(new Notification.BigTextStyle().bigText(o.text))
                .setContentText(o.ok ? "Checked: it worked." : "Open Holdfast for details.")
                .setAutoCancel(true);
        if (o.ok) b.setTimeoutAfter(15_000);
        nm(c).notify(ctl.id.hashCode(), b.build());
    }
}

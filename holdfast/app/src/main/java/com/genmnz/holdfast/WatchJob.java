package com.genmnz.holdfast;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.net.Uri;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The watchdog, without a resident service: one job that JobScheduler starts when any watched
 * settings key changes, and one periodic backstop (every 15 minutes) for things with no URI.
 */
public class WatchJob extends JobService {
    static final int CONTENT = 1, PERIODIC = 2;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        ComponentName me = new ComponentName(c, WatchJob.class);
        Set<Uri> uris = new LinkedHashSet<>();
        Set<String> held = Store.held(c);
        if (held.isEmpty()) {
            js.cancel(CONTENT);
            js.cancel(PERIODIC);
            return;
        }
        for (String id : held) {
            Control ctl = Controls.byId(c, id);
            if (ctl != null) for (Uri u : ctl.watch()) uris.add(u);
        }
        if (uris.isEmpty()) {
            js.cancel(CONTENT);
        } else {
            JobInfo.Builder b = new JobInfo.Builder(CONTENT, me)
                    .setTriggerContentUpdateDelay(500)
                    .setTriggerContentMaxDelay(3000);
            for (Uri u : uris) b.addTriggerContentUri(new JobInfo.TriggerContentUri(u, 0));
            js.schedule(b.build());
        }
        if (js.getPendingJob(PERIODIC) == null) {
            js.schedule(new JobInfo.Builder(PERIODIC, me)
                    .setPeriodic(15 * 60_000L)
                    .setPersisted(true)
                    .build());
        }
    }

    static String status(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        JobInfo ci = js.getPendingJob(CONTENT), pi = js.getPendingJob(PERIODIC);
        return "instant watcher: " + (ci == null ? "off" : "armed on " + (ci.getTriggerContentUris() == null ? 0
                : ci.getTriggerContentUris().length) + " settings keys")
                + "; 15-min backstop: " + (pi == null ? "off" : "armed");
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            String trigger = "periodic check";
            if (params.getJobId() == CONTENT) {
                List<String> keys = new ArrayList<>();
                if (params.getTriggeredContentUris() != null)
                    for (Uri u : params.getTriggeredContentUris()) keys.add(u.getLastPathSegment());
                trigger = "change of " + (keys.isEmpty() ? "a watched setting" : String.join(", ", keys));
            }
            try {
                Enforcer.check(this, trigger);
            } finally {
                if (params.getJobId() == CONTENT) schedule(this);
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}

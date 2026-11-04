package com.genmnz.holdfast;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.HashSet;
import java.util.Set;

/** Desired state and per-control history. One small SharedPreferences file. */
final class Store {
    static final String ASK = "ask";
    static final String AUTO = "auto";
    static final String UNSET = "(unset)";

    private Store() {}

    static SharedPreferences p(Context c) {
        return c.getSharedPreferences("holdfast", Context.MODE_PRIVATE);
    }

    static Set<String> held(Context c) {
        return new HashSet<>(p(c).getStringSet("held", new HashSet<>()));
    }

    static boolean isHeld(Context c, String id) {
        return held(c).contains(id);
    }

    static void hold(Context c, String id, String mode, String stepKey) {
        Set<String> h = held(c);
        h.add(id);
        p(c).edit().putStringSet("held", h).putString("mode." + id, mode).putString("path." + id, stepKey).apply();
    }

    static void release(Context c, String id) {
        Set<String> h = held(c);
        h.remove(id);
        p(c).edit().putStringSet("held", h).remove("mode." + id).remove("path." + id).apply();
    }

    static String mode(Context c, String id) {
        return p(c).getString("mode." + id, ASK);
    }

    static String path(Context c, String id) {
        return p(c).getString("path." + id, null);
    }

    /** Saves the value before Holdfast's first change, so Restore can put it back. Never overwritten. */
    static void saveOriginal(Context c, String id, String value) {
        if (!p(c).contains("orig." + id))
            p(c).edit().putString("orig." + id, value == null ? UNSET : value).apply();
    }

    static String original(Context c, String id) {
        return p(c).getString("orig." + id, null);
    }

    static void forgetOriginal(Context c, String id) {
        p(c).edit().remove("orig." + id).apply();
    }

    static void last(Context c, String id, String text) {
        p(c).edit().putString("last." + id, EventLog.now() + " · " + text).apply();
    }

    static String last(Context c, String id) {
        return p(c).getString("last." + id, null);
    }

    static void drift(Context c, String id, String seen) {
        SharedPreferences s = p(c);
        s.edit().putInt("drifts." + id, s.getInt("drifts." + id, 0) + 1)
                .putString("driftAt." + id, EventLog.now() + " (saw " + seen + ")").apply();
    }

    static int drifts(Context c, String id) {
        return p(c).getInt("drifts." + id, 0);
    }

    static String driftAt(Context c, String id) {
        return p(c).getString("driftAt." + id, null);
    }

    static String param(Context c, String id) {
        return p(c).getString("param." + id, null);
    }

    static void param(Context c, String id, String v) {
        p(c).edit().putString("param." + id, v).apply();
    }

    static boolean manual(Context c, String key) {
        return p(c).getBoolean("manual." + key, false);
    }

    static void manual(Context c, String key, boolean done) {
        p(c).edit().putBoolean("manual." + key, done).putString("manualAt." + key, EventLog.now()).apply();
    }

    /** Remembers recent automatic re-applies so a fight with another component can't loop forever. */
    static boolean allowAuto(Context c, String id) {
        long now = System.currentTimeMillis();
        String k = "auto." + id;
        String[] prev = p(c).getString(k, "").split(",");
        StringBuilder keep = new StringBuilder();
        int recent = 0;
        for (String t : prev) {
            if (t.isEmpty()) continue;
            long v = Long.parseLong(t);
            if (now - v < 10 * 60_000L) {
                recent++;
                keep.append(v).append(',');
            }
        }
        if (recent >= 3) return false;
        p(c).edit().putString(k, keep.append(now).toString()).apply();
        return true;
    }
}

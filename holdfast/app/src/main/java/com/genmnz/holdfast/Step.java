package com.genmnz.holdfast;

import android.content.Context;

/**
 * One concrete way to make a change. {@link #lines} is exactly what will run, and is what the
 * confirm dialog shows before anything happens.
 */
final class Step {
    interface Action {
        /** Does the work. Returns output worth showing (may be empty). Throws on failure. */
        String run(Context c) throws Exception;
    }

    final Tier tier;
    final String how;
    final String[] lines;
    final Action action;

    Step(Tier tier, String how, String[] lines, Action action) {
        this.tier = tier;
        this.how = how;
        this.lines = lines;
        this.action = action;
    }

    static Step api(Tier tier, String how, String line, Action action) {
        return new Step(tier, how, new String[]{line}, action);
    }

    /** Runs each command through Shizuku, in order. Fails if any exits non-zero, after running all. */
    static Step shell(String how, String... cmds) {
        return new Step(Tier.SHIZUKU, how, cmds, c -> {
            StringBuilder out = new StringBuilder();
            StringBuilder bad = new StringBuilder();
            for (String cmd : cmds) {
                Shell.Result r = Shell.run(c, cmd);
                out.append("$ ").append(cmd).append("\n");
                if (!r.out.isEmpty()) out.append(r.out.trim()).append("\n");
                if (r.exit != 0) {
                    out.append("(exit ").append(r.exit).append(")\n");
                    bad.append(cmd).append(" → exit ").append(r.exit).append("; ");
                }
            }
            if (bad.length() > 0) throw new Exception(bad + "\n" + out);
            return out.toString();
        });
    }

    String text() {
        return String.join("\n", lines);
    }

    /** Stable key, used to remember which path the user confirmed for a held control. */
    String key() {
        return tier.name() + ":" + how;
    }
}

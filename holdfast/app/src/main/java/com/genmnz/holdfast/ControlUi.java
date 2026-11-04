package com.genmnz.holdfast;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.text.InputType;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The dialogs. Nothing changes on the device until the user presses the button in a confirm dialog. */
final class ControlUi {
    private ControlUi() {}

    // ------------------------------------------------------------------ details

    static void details(Activity a, Control ctl, Runnable changed) {
        Ui.bg(a, () -> ctl.read(a), s -> showDetails(a, ctl, s, changed));
    }

    private static void showDetails(Activity a, Control ctl, Control.State s, Runnable changed) {
        LinearLayout v = Ui.column(a);
        int p = Ui.dp(a, 20);
        v.setPadding(p, Ui.dp(a, 8), p, 0);

        TextView now = Ui.text(a, Ui.stateMark(s.ok) + "  Now: " + s.value, 16);
        now.setTextColor(Ui.stateColor(s.ok));
        now.setTypeface(Typeface.DEFAULT_BOLD);
        v.addView(now);
        v.addView(Ui.secondary(a, "Wanted: " + ctl.want
                + (ctl.paramPrompt != null ? "\nYour value: " + (ctl.param(a) == null ? "not set" : ctl.param(a)) : "")));
        v.addView(gap(a));
        v.addView(Ui.text(a, ctl.about, 14));
        v.addView(gap(a));
        v.addView(Ui.text(a, "Side effects: " + ctl.effects, 14));
        v.addView(gap(a));

        StringBuilder diag = new StringBuilder();
        boolean held = Store.isHeld(a, ctl.id);
        diag.append(held ? "Held · " + (Store.AUTO.equals(Store.mode(a, ctl.id)) ? "fixes automatically" : "asks before fixing")
                + "\nConfirmed path: " + Store.path(a, ctl.id) : "Not held (Holdfast won't watch it)");
        if (!ctl.holdable) diag.append(" · can't be held: temporary by nature");
        String last = Store.last(a, ctl.id);
        diag.append("\nLast action: ").append(last == null ? "none" : last);
        int d = Store.drifts(a, ctl.id);
        diag.append("\nChanged back: ").append(d).append(d > 0 ? " times, last " + Store.driftAt(a, ctl.id) : " times");
        String o = Store.original(a, ctl.id);
        diag.append("\nBefore Holdfast: ").append(o == null ? "not recorded yet" : o);
        v.addView(Ui.mono(a, diag));

        ScrollView sv = new ScrollView(a);
        sv.addView(v);
        AlertDialog[] dlg = new AlertDialog[1];
        List<android.widget.Button> bs = new ArrayList<>();
        bs.add(Ui.button(a, "Apply once…", x -> {
            dlg[0].dismiss();
            confirm(a, ctl, false, false, changed);
        }));
        if (ctl.holdable) bs.add(Ui.button(a, held ? "Stop holding…" : "Hold…", x -> {
            dlg[0].dismiss();
            if (held) confirmRelease(a, ctl, changed);
            else confirm(a, ctl, false, true, changed);
        }));
        bs.add(Ui.button(a, "Restore…", x -> {
            dlg[0].dismiss();
            confirm(a, ctl, true, false, changed);
        }));
        if (ctl.paramPrompt != null) bs.add(Ui.button(a, "Change value…", x -> {
            dlg[0].dismiss();
            askParam(a, ctl, () -> details(a, ctl, changed));
        }));
        v.addView(gap(a));
        v.addView(Ui.buttons(a, bs.toArray(new android.widget.Button[0])));
        dlg[0] = new AlertDialog.Builder(a).setTitle(ctl.title).setView(sv).setNegativeButton("Close", null).show();
    }

    // ------------------------------------------------------------------ confirm

    static void confirm(Activity a, Control ctl, boolean restoring, boolean hold, Runnable changed) {
        if (!restoring && ctl.paramPrompt != null && ctl.param(a) == null) {
            askParam(a, ctl, () -> confirm(a, ctl, false, hold, changed));
            return;
        }
        Ui.bg(a, () -> new Object[]{ctl.read(a), restoring ? ctl.restore(a) : ctl.apply(a), Privs.now(a)},
                r -> showConfirm(a, ctl, (Control.State) r[0], cast(r[1]), (Privs) r[2], restoring, hold, changed));
    }

    @SuppressWarnings("unchecked")
    private static List<Step> cast(Object o) {
        return (List<Step>) o;
    }

    private static void showConfirm(Activity a, Control ctl, Control.State s, List<Step> steps, Privs p,
                                    boolean restoring, boolean hold, Runnable changed) {
        LinearLayout v = Ui.column(a);
        int pad = Ui.dp(a, 20);
        v.setPadding(pad, Ui.dp(a, 8), pad, 0);

        boolean already = !restoring && Boolean.TRUE.equals(s.ok);
        boolean wasHeld = restoring && Store.isHeld(a, ctl.id);
        String o = Store.original(a, ctl.id);
        v.addView(Ui.text(a, restoring
                ? "Now: " + s.value + "\nBack to: " + (o == null ? "the default (no original recorded)" : o)
                + (wasHeld ? "\nThis also stops holding it, so Holdfast won't change it back." : "")
                : "Now: " + s.value + "\nWanted: " + ctl.want
                + (already ? "\nAlready as wanted." + (hold ? " Holdfast will only watch it." : "") : ""), 15));
        v.addView(gap(a));

        TextView cmd = Ui.mono(a, "");
        RadioGroup rg = new RadioGroup(a);
        Step[] chosen = new Step[1];
        String remembered = Store.path(a, ctl.id);
        int firstOk = -1;
        for (int i = 0; i < steps.size(); i++) {
            Step st = steps.get(i);
            RadioButton rb = new RadioButton(a);
            rb.setId(View.generateViewId());
            boolean can = p.has(st.tier);
            rb.setText(st.tier.label + " — " + st.how + (can ? "" : "  (not held)"));
            rb.setEnabled(can);
            rb.setTag(st);
            rg.addView(rb);
            if (can && (firstOk < 0 || st.key().equals(remembered))) firstOk = rb.getId();
        }
        rg.setOnCheckedChangeListener((g, id) -> {
            Step st = (Step) g.findViewById(id).getTag();
            chosen[0] = st;
            cmd.setText(st.text());
        });
        if (!already || !hold) {
            v.addView(Ui.secondary(a, restoring ? "How to restore:" : "How to apply:"));
            v.addView(rg);
            v.addView(Ui.secondary(a, "Exactly what will run:"));
            v.addView(cmd);
        }
        if (firstOk >= 0) rg.check(firstOk);
        else cmd.setText("Nothing Holdfast holds can do this.\nNeeds one of: " + needs(steps)
                + "\nSee Privileges on the main screen.");

        RadioGroup mode = new RadioGroup(a);
        if (hold) {
            v.addView(gap(a));
            v.addView(Ui.secondary(a, "When something changes it back:"));
            RadioButton ask = new RadioButton(a);
            ask.setId(View.generateViewId());
            ask.setText("Ask me with a notification (shows the command; nothing runs until I tap Re-apply)");
            RadioButton auto = new RadioButton(a);
            auto.setId(View.generateViewId());
            auto.setText("Fix it automatically and log it (pauses after 3 fixes in 10 min)");
            auto.setTag(Store.AUTO);
            mode.addView(ask);
            mode.addView(auto);
            mode.check(ask.getId());
            v.addView(mode);
        }
        if (!restoring) {
            v.addView(gap(a));
            v.addView(Ui.text(a, "Side effects: " + ctl.effects, 13));
        }

        ScrollView sv = new ScrollView(a);
        sv.addView(v);
        boolean runnable = firstOk >= 0 || (already && hold);
        String label = restoring ? "Restore" : hold ? (already ? "Hold" : "Apply and hold") : "Apply";
        AlertDialog.Builder b = new AlertDialog.Builder(a)
                .setTitle((restoring ? "Restore: " : hold ? "Hold: " : "Apply: ") + ctl.title)
                .setView(sv)
                .setNegativeButton("Cancel", null);
        if (runnable) b.setPositiveButton(label, (d, w) -> {
            View m = mode.findViewById(mode.getCheckedRadioButtonId());
            String md = m != null && Store.AUTO.equals(m.getTag()) ? Store.AUTO : Store.ASK;
            Step st = chosen[0];
            if (already && hold) {
                if (st == null) st = Enforcer.pick(a, ctl);
                doHold(a, ctl, md, st);
                result(a, "Holding " + ctl.title, "Already as wanted. Watching it now"
                        + (st == null ? "; no path is available to fix it later." : "; would fix via " + st.tier.label + ":\n" + st.text()));
                changed.run();
                return;
            }
            Step run = st;
            if (wasHeld) {
                Store.release(a, ctl.id);
                EventLog.add(a, "RELEASE", ctl.id, "no longer held (restoring)");
                Enforcer.nm(a).cancel(ctl.id.hashCode());
                Ui.BG.execute(() -> WatchJob.schedule(a));
            }
            Ui.bg(a, () -> Enforcer.run(a, ctl, run, restoring, "you, in the app"), out -> {
                if (hold) {
                    if (out.ok) doHold(a, ctl, md, run);
                    result(a, out.ok ? "Done ✓ — now holding" : "Didn't stick — not held",
                            out.text + (out.ok ? "" : "\n\nHolding needs a path that verifies. Try another one."));
                } else {
                    result(a, out.ok ? "Done ✓" : "Check this", out.text);
                }
                changed.run();
            });
        });
        b.show();
    }

    private static void doHold(Activity a, Control ctl, String mode, Step step) {
        Store.hold(a, ctl.id, mode, step == null ? null : step.key());
        EventLog.add(a, "HOLD", ctl.id, "mode " + mode + (step == null ? "" : " · path " + step.key()));
        if (Store.ASK.equals(mode)) {
            Enforcer.nm(a); // creating the channel makes Android ask for notification permission
            if (Build.VERSION.SDK_INT >= 33 && a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED)
                a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        Ui.BG.execute(() -> WatchJob.schedule(a));
    }

    static void confirmRelease(Activity a, Control ctl, Runnable changed) {
        new AlertDialog.Builder(a)
                .setTitle("Stop holding: " + ctl.title)
                .setMessage("Holdfast stops watching this. Nothing on the phone changes now: the current value stays. "
                        + "Use Restore if you also want the old value back.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Stop holding", (d, w) -> {
                    Store.release(a, ctl.id);
                    EventLog.add(a, "RELEASE", ctl.id, "no longer held");
                    Enforcer.nm(a).cancel(ctl.id.hashCode());
                    Ui.BG.execute(() -> WatchJob.schedule(a));
                    changed.run();
                })
                .show();
    }

    // ------------------------------------------------------------------ review all

    static void reviewAll(Activity a, Runnable changed) {
        Ui.bg(a, () -> {
            List<Object[]> rows = new ArrayList<>();
            Privs p = Privs.now(a);
            for (Control c : Controls.all(a)) {
                if (c.paramPrompt != null || c.id.startsWith("pkg:") || c.id.startsWith("app:")) continue;
                Control.State s = c.read(a);
                if (!Boolean.FALSE.equals(s.ok)) continue;
                Step best = null;
                List<Step> steps = c.apply(a);
                for (Step st : steps) if (p.has(st.tier)) { best = st; break; }
                rows.add(new Object[]{c, s, best, needs(steps)});
            }
            return rows;
        }, rows -> showReview(a, rows, changed));
    }

    private static void showReview(Activity a, List<Object[]> rows, Runnable changed) {
        if (rows.isEmpty()) {
            result(a, "Review", "Every location and scanning control is already as wanted, or can't be read.\n"
                    + "(Packages, Private DNS and per-app rules are reviewed one at a time.)");
            return;
        }
        LinearLayout v = Ui.column(a);
        int pad = Ui.dp(a, 20);
        v.setPadding(pad, Ui.dp(a, 8), pad, 0);
        v.addView(Ui.secondary(a, "Not as wanted yet. Tick each step you want; nothing is ticked for you."));
        CheckBox all = new CheckBox(a);
        all.setText("Tick all that can run");
        v.addView(all);
        List<CheckBox> boxes = new ArrayList<>();
        for (Object[] r : rows) {
            Control c = (Control) r[0];
            Control.State s = (Control.State) r[1];
            Step st = (Step) r[2];
            CheckBox cb = new CheckBox(a);
            cb.setText(c.title + "\nnow " + s.value + " → " + c.want);
            cb.setEnabled(st != null);
            cb.setTag(r);
            v.addView(cb);
            v.addView(Ui.mono(a, st == null ? "can't run: needs " + r[3] : st.tier.label + ":\n" + st.text()));
            if (st != null) boxes.add(cb);
        }
        all.setOnCheckedChangeListener((x, on) -> {
            for (CheckBox cb : boxes) cb.setChecked(on);
        });
        ScrollView sv = new ScrollView(a);
        sv.addView(v);
        new AlertDialog.Builder(a)
                .setTitle("Review all")
                .setView(sv)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Run ticked steps", (d, w) -> {
                    List<Object[]> pick = new ArrayList<>();
                    for (CheckBox cb : boxes) if (cb.isChecked()) pick.add((Object[]) cb.getTag());
                    if (pick.isEmpty()) return;
                    Ui.bg(a, () -> {
                        StringBuilder sb = new StringBuilder();
                        int ok = 0;
                        for (Object[] r : pick) {
                            Control c = (Control) r[0];
                            Enforcer.Outcome out = Enforcer.run(a, c, (Step) r[2], false, "you, review all");
                            if (out.ok) ok++;
                            sb.append(out.ok ? "✓ " : "✗ ").append(c.title).append("\n").append(out.text).append("\n\n");
                        }
                        return String.format(Locale.US, "%d of %d verified.\n\n", ok, pick.size()) + sb;
                    }, text -> {
                        result(a, "Review results", text);
                        changed.run();
                    });
                })
                .show();
    }

    // ------------------------------------------------------------------ helpers

    static void askParam(Activity a, Control ctl, Runnable then) {
        EditText e = new EditText(a);
        e.setSingleLine();
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String cur = ctl.param(a);
        if (cur != null) e.setText(cur);
        LinearLayout v = Ui.column(a);
        int pad = Ui.dp(a, 20);
        v.setPadding(pad, Ui.dp(a, 8), pad, 0);
        v.addView(Ui.secondary(a, ctl.paramPrompt));
        v.addView(e);
        new AlertDialog.Builder(a)
                .setTitle(ctl.title)
                .setView(v)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", (d, w) -> {
                    String val = e.getText().toString().trim().toLowerCase(Locale.US);
                    boolean good = "sim_country".equals(ctl.id) ? val.matches("[a-z]{2}")
                            : val.matches("[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+");
                    if (!good) {
                        Ui.toast(a, "That doesn't look right: " + ctl.paramPrompt);
                        return;
                    }
                    Store.param(a, ctl.id, val);
                    EventLog.add(a, "VALUE", ctl.id, "set to " + val + " (nothing applied yet)");
                    then.run();
                })
                .show();
    }

    static void result(Activity a, String title, String text) {
        ScrollView sv = new ScrollView(a);
        TextView t = Ui.mono(a, text);
        sv.addView(t);
        int pad = Ui.dp(a, 16);
        sv.setPadding(pad, pad, pad, 0);
        new AlertDialog.Builder(a).setTitle(title).setView(sv)
                .setNeutralButton("Copy", (d, w) -> Ui.copy(a, title, text))
                .setPositiveButton("OK", null).show();
    }

    static String needs(List<Step> steps) {
        List<String> n = new ArrayList<>();
        for (Step s : steps) if (!n.contains(s.tier.label)) n.add(s.tier.label);
        return String.join(" or ", n);
    }

    private static View gap(Activity a) {
        View g = new View(a);
        g.setLayoutParams(new LinearLayout.LayoutParams(1, Ui.dp(a, 10)));
        return g;
    }

    static void open(Activity a, Intent i) {
        try {
            a.startActivity(i);
        } catch (Exception e) {
            Ui.toast(a, "This phone has no screen for that. Find it in Settings yourself.");
        }
    }
}

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

/**
 * The dialogs, in plain words. Technical detail (exact commands, raw values) is always one tap
 * away under "Technical details", and nothing changes until the user presses the confirm button.
 */
final class ControlUi {
    private ControlUi() {}

    // ------------------------------------------------------------------ details

    static void details(Activity a, Control ctl, Runnable changed) {
        Ui.bg(a, () -> {
            List<Step> steps = ctl.apply(a);
            return new Object[]{ctl.read(a), Enforcer.pick(a, ctl), needs(steps)};
        }, r -> showDetails(a, ctl, (Control.State) r[0], (Step) r[1], (String) r[2], changed));
    }

    private static void showDetails(Activity a, Control ctl, Control.State s, Step best, String needs, Runnable changed) {
        LinearLayout v = pad(a);
        boolean held = Store.isHeld(a, ctl.id);
        boolean ok = Boolean.TRUE.equals(s.ok);

        TextView now = Ui.text(a, Ui.stateMark(s.ok) + "  " + ctl.human(s), 20);
        now.setTextColor(Ui.stateColor(s.ok));
        now.setTypeface(Typeface.DEFAULT_BOLD);
        v.addView(now);
        v.addView(Ui.text(a, ok ? "Already private. Nothing to do."
                : s.ok == null ? "Holdfast can't read this one, so it can't tell."
                : "This is still active.", 14));
        if (held) v.addView(Ui.secondary(a, "Holdfast is keeping it this way. If anything changes it back, Holdfast "
                + (Store.AUTO.equals(Store.mode(a, ctl.id)) ? "fixes it on its own and logs it." : "sends you a notification and waits for you.")));

        v.addView(Ui.heading(a, "What it is"));
        v.addView(Ui.text(a, ctl.about, 14));
        v.addView(Ui.heading(a, "If you change it"));
        v.addView(Ui.text(a, ctl.effects, 14));
        if (ctl.paramPrompt != null)
            v.addView(Ui.secondary(a, "\nYour value: " + (ctl.param(a) == null ? "not chosen yet" : ctl.param(a))));
        v.addView(gap(a));

        AlertDialog[] dlg = new AlertDialog[1];
        Runnable close = () -> dlg[0].dismiss();
        if (best == null) {
            v.addView(Ui.text(a, "Holdfast doesn't have the permission this needs yet (" + needs + ").", 14));
            v.addView(Ui.action(a, "How to give it", null, x -> {
                close.run();
                a.startActivity(new Intent(a, SetupActivity.class));
            }));
        } else {
            if (!ok) v.addView(Ui.action(a, ctl.verb + " now",
                    "Changes it once. If something changes it back later, it stays that way.", x -> {
                        close.run();
                        confirm(a, ctl, false, false, changed);
                    }));
            if (ctl.holdable && !held) v.addView(Ui.action(a, ok ? "Keep it this way" : ctl.verb + " and keep it that way",
                    "Holdfast watches it from now on. If Samsung, Google or an app changes it back, you get a notification "
                            + "and choose whether to fix it.", x -> {
                        close.run();
                        confirm(a, ctl, false, true, changed);
                    }));
        }
        if (held) v.addView(Ui.action(a, "Stop watching it",
                "Holdfast stops watching. Nothing on the phone changes.", x -> {
                    close.run();
                    confirmRelease(a, ctl, changed);
                }));
        if (Store.original(a, ctl.id) != null) v.addView(Ui.action(a, "Put it back the way it was",
                "Undoes Holdfast's change, back to how it was before you first used Holdfast on it.", x -> {
                    close.run();
                    confirm(a, ctl, true, false, changed);
                }));
        if (ctl.paramPrompt != null) v.addView(Ui.action(a, "Choose value…", ctl.paramPrompt, x -> {
            close.run();
            askParam(a, ctl, () -> details(a, ctl, changed));
        }));

        StringBuilder diag = new StringBuilder();
        diag.append("Raw value: ").append(s.value).append("\nWanted: ").append(ctl.want);
        diag.append("\nWould use: ").append(best == null ? "nothing (needs " + needs + ")" : best.tier.label + "\n  " + best.text());
        if (held) diag.append("\nWatching mode: ").append(Store.mode(a, ctl.id)).append(" · method ").append(Store.path(a, ctl.id));
        String last = Store.last(a, ctl.id);
        diag.append("\nLast action: ").append(last == null ? "none" : last);
        int d = Store.drifts(a, ctl.id);
        diag.append("\nChanged back by something else: ").append(d).append(d > 0 ? " times, last " + Store.driftAt(a, ctl.id) : " times");
        String o = Store.original(a, ctl.id);
        diag.append("\nBefore Holdfast: ").append(o == null ? "not recorded (Holdfast hasn't changed it)" : o);
        v.addView(Ui.expander(a, "Technical details", Ui.mono(a, diag)));

        dlg[0] = new AlertDialog.Builder(a).setTitle(ctl.title).setView(scroll(a, v)).setNegativeButton("Close", null).show();
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
        LinearLayout v = pad(a);
        boolean already = !restoring && Boolean.TRUE.equals(s.ok);
        boolean wasHeld = restoring && Store.isHeld(a, ctl.id);

        String what;
        if (restoring) {
            what = ctl.title + " goes back to how it was before Holdfast changed it."
                    + (wasHeld ? "\nHoldfast also stops watching it." : "");
        } else if (already) {
            what = "It's already " + ctl.doneWord.toLowerCase(Locale.ROOT) + ". Holdfast changes nothing now, and starts watching it.";
        } else {
            what = "Now: " + ctl.human(s) + "\nAfter: " + ctl.doneWord;
        }
        v.addView(Ui.text(a, what, 16));
        if (!restoring) {
            v.addView(gap(a));
            v.addView(Ui.secondary(a, "If you change it: " + ctl.effects));
        }

        RadioGroup mode = new RadioGroup(a);
        if (hold) {
            v.addView(Ui.heading(a, "If something changes it back"));
            RadioButton ask = radio(a, "Ask me first (recommended)\nYou get a notification with a Fix it button. Nothing runs until you tap it.");
            RadioButton auto = radio(a, "Fix it on its own\nHoldfast changes it again right away and logs it. It stops after 3 times in 10 minutes and asks you instead.");
            auto.setTag(Store.AUTO);
            mode.addView(ask);
            mode.addView(auto);
            mode.check(ask.getId());
            v.addView(mode);
        }

        // Technical details: which method, and the exact command.
        LinearLayout tech = Ui.column(a);
        TextView cmd = Ui.mono(a, "");
        RadioGroup rg = new RadioGroup(a);
        Step[] chosen = new Step[1];
        String remembered = Store.path(a, ctl.id);
        int firstOk = -1;
        for (Step st : steps) {
            boolean can = p.has(st.tier);
            RadioButton rb = radio(a, st.tier.label + " — " + st.how + (can ? "" : "  (no permission)"));
            rb.setEnabled(can);
            rb.setTag(st);
            rg.addView(rb);
            if (can && (firstOk < 0 || st.key().equals(remembered))) firstOk = rb.getId();
        }
        rg.setOnCheckedChangeListener((g, id) -> {
            chosen[0] = (Step) g.findViewById(id).getTag();
            cmd.setText(chosen[0].text());
        });
        tech.addView(Ui.secondary(a, "Method (the best one you have is already picked):"));
        tech.addView(rg);
        tech.addView(Ui.secondary(a, "Exactly what runs:"));
        tech.addView(cmd);
        if (firstOk >= 0) rg.check(firstOk);
        boolean runnable = firstOk >= 0 || (already && hold);
        if (!runnable) {
            v.addView(gap(a));
            v.addView(Ui.text(a, "Holdfast doesn't have the permission this needs (" + needs(steps) + "). See Setup.", 14));
        } else if (!(already && hold)) {
            v.addView(gap(a));
            v.addView(Ui.expander(a, "Technical details", tech));
        }

        String verb = restoring ? "Put it back" : hold ? (already ? "Keep it this way" : ctl.verb + " and keep") : ctl.verb;
        String title = restoring ? "Undo " + ctl.title + "?"
                : already ? "Keep " + ctl.title + " " + ctl.doneWord.toLowerCase(Locale.ROOT) + "?"
                : ctl.verb + " " + ctl.title + "?";
        AlertDialog.Builder b = new AlertDialog.Builder(a).setTitle(title).setView(scroll(a, v)).setNegativeButton("Cancel", null);
        if (runnable) b.setPositiveButton(verb, (d, w) -> {
            View m = mode.findViewById(mode.getCheckedRadioButtonId());
            String md = m != null && Store.AUTO.equals(m.getTag()) ? Store.AUTO : Store.ASK;
            Step st = chosen[0];
            if (already && hold) {
                doHold(a, ctl, md, st != null ? st : Enforcer.pick(a, ctl));
                plain(a, "Watching ✓", ctl.title + " is " + ctl.doneWord.toLowerCase(Locale.ROOT)
                        + ". Holdfast will tell you if anything changes it.", null);
                changed.run();
                return;
            }
            if (wasHeld) {
                Store.release(a, ctl.id);
                EventLog.add(a, "RELEASE", ctl.id, "no longer held (restoring)");
                Enforcer.nm(a).cancel(ctl.id.hashCode());
                Ui.BG.execute(() -> WatchJob.schedule(a));
            }
            Ui.bg(a, () -> Enforcer.run(a, ctl, st, restoring, "you, in the app"), out -> {
                if (hold && out.ok) doHold(a, ctl, md, st);
                showOutcome(a, ctl, out, restoring, hold);
                changed.run();
            });
        });
        b.show();
    }

    private static void showOutcome(Activity a, Control ctl, Enforcer.Outcome out, boolean restoring, boolean hold) {
        String title, msg;
        if (restoring) {
            title = out.ok ? "Put back ✓" : "Couldn't put it back";
            msg = out.ok ? ctl.title + " is back to how it was." : "The phone refused: " + out.error;
        } else switch (out.kind) {
            case Enforcer.WORKED:
                title = "Done ✓";
                msg = ctl.title + " is now " + ctl.doneWord.toLowerCase(Locale.ROOT) + ". Holdfast checked, and it worked."
                        + (hold ? "\nHoldfast is watching it now." : "");
                break;
            case Enforcer.DIDNT_TAKE:
                title = "It didn't take";
                msg = "The phone accepted the change but " + ctl.title + " is still " + ctl.todoWord.toLowerCase(Locale.ROOT)
                        + ". Samsung probably ignores this method. Try again and pick another method under Technical details."
                        + (hold ? "\nNot watching it, because it didn't work." : "");
                break;
            case Enforcer.UNSURE:
                title = "Done, but can't check";
                msg = "The change ran, but Holdfast can't read this setting to confirm it.";
                break;
            default:
                title = "Couldn't do it";
                msg = "The phone refused: " + out.error;
        }
        plain(a, title, msg, out.text);
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
                .setTitle("Stop watching " + ctl.title + "?")
                .setMessage("Holdfast stops watching it. Nothing on the phone changes now; it stays as it is.\n\n"
                        + "If you also want the old value back, use \"Put it back the way it was\".")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Stop watching", (d, w) -> {
                    Store.release(a, ctl.id);
                    EventLog.add(a, "RELEASE", ctl.id, "no longer held");
                    Enforcer.nm(a).cancel(ctl.id.hashCode());
                    Ui.BG.execute(() -> WatchJob.schedule(a));
                    changed.run();
                })
                .show();
    }

    // ------------------------------------------------------------------ turn off all recommended

    static void reviewAll(Activity a, Runnable changed) {
        Ui.bg(a, () -> {
            List<Object[]> rows = new ArrayList<>();
            Privs p = Privs.now(a);
            for (Control c : Controls.all(a)) {
                if (!Controls.M_LOCATION.equals(c.module) && !Controls.M_SCAN.equals(c.module)
                        && !Controls.M_TIME.equals(c.module)) continue;
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
            plain(a, "Nothing to do ✓", "Location, scanning and time zone are already off (or Holdfast can't read them).\n\n"
                    + "Apps and Private DNS are done one at a time from the main screen.", null);
            return;
        }
        LinearLayout v = pad(a);
        v.addView(Ui.text(a, "These are still on. Tick the ones to turn off. Nothing is ticked for you.", 15));
        CheckBox all = new CheckBox(a);
        all.setText("Tick all");
        v.addView(all);
        List<CheckBox> boxes = new ArrayList<>();
        StringBuilder cmds = new StringBuilder();
        List<String> cant = new ArrayList<>();
        for (Object[] r : rows) {
            Control c = (Control) r[0];
            Step st = (Step) r[2];
            if (st == null) {
                cant.add(c.title);
                continue;
            }
            CheckBox cb = new CheckBox(a);
            cb.setText(c.title + "\n" + c.effects);
            cb.setTag(r);
            v.addView(cb);
            boxes.add(cb);
            cmds.append(c.title).append(" (").append(st.tier.label).append("):\n  ").append(st.text().replace("\n", "\n  ")).append("\n");
        }
        if (!cant.isEmpty())
            v.addView(Ui.secondary(a, "\nNeeds more permission first (see Setup): " + String.join(", ", cant)));
        v.addView(Ui.expander(a, "Technical details (exact commands)", Ui.mono(a, cmds.toString().trim())));
        all.setOnCheckedChangeListener((x, on) -> {
            for (CheckBox cb : boxes) cb.setChecked(on);
        });
        AlertDialog.Builder b = new AlertDialog.Builder(a)
                .setTitle("Turn off the recommended ones")
                .setView(scroll(a, v))
                .setNegativeButton("Cancel", null);
        if (!boxes.isEmpty()) b.setPositiveButton("Turn off ticked", (d, w) -> {
            List<Object[]> pick = new ArrayList<>();
            for (CheckBox cb : boxes) if (cb.isChecked()) pick.add((Object[]) cb.getTag());
            if (pick.isEmpty()) return;
            Ui.bg(a, () -> {
                StringBuilder plain = new StringBuilder(), tech = new StringBuilder();
                int ok = 0;
                for (Object[] r : pick) {
                    Control c = (Control) r[0];
                    Enforcer.Outcome out = Enforcer.run(a, c, (Step) r[2], false, "you, turn off recommended");
                    if (out.ok) ok++;
                    plain.append(out.ok ? "✓ " : "✗ ").append(c.title).append(out.ok ? " — off"
                            : out.kind == Enforcer.DIDNT_TAKE ? " — didn't take" : " — failed").append("\n");
                    tech.append(c.title).append("\n").append(out.text).append("\n\n");
                }
                return new String[]{String.format(Locale.US, "%d of %d worked.\n\n", ok, pick.size()) + plain
                        + (ok < pick.size() ? "\nTap a ✗ row on the main screen to try another method." : ""), tech.toString()};
            }, res -> {
                plain(a, "Results", res[0], res[1]);
                changed.run();
            });
        });
        b.show();
    }

    // ------------------------------------------------------------------ helpers

    static void askParam(Activity a, Control ctl, Runnable then) {
        EditText e = new EditText(a);
        e.setSingleLine();
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String cur = ctl.param(a);
        if (cur != null) e.setText(cur);
        LinearLayout v = pad(a);
        v.addView(Ui.secondary(a, ctl.paramPrompt + "\nSaving this changes nothing on the phone yet."));
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

    /** A plain-language message, with the technical text (if any) behind a toggle and copyable. */
    static void plain(Activity a, String title, String msg, String tech) {
        LinearLayout v = pad(a);
        v.addView(Ui.text(a, msg, 15));
        if (tech != null && !tech.trim().isEmpty()) {
            v.addView(gap(a));
            v.addView(Ui.expander(a, "Technical details", Ui.mono(a, tech.trim())));
        }
        AlertDialog.Builder b = new AlertDialog.Builder(a).setTitle(title).setView(scroll(a, v)).setPositiveButton("OK", null);
        if (tech != null) b.setNeutralButton("Copy details", (d, w) -> Ui.copy(a, title, msg + "\n\n" + tech));
        b.show();
    }

    static String needs(List<Step> steps) {
        List<String> n = new ArrayList<>();
        for (Step s : steps) if (!n.contains(s.tier.label)) n.add(s.tier.label);
        return String.join(" or ", n);
    }

    private static RadioButton radio(Activity a, String text) {
        RadioButton rb = new RadioButton(a);
        rb.setId(View.generateViewId());
        rb.setText(text);
        int p = Ui.dp(a, 4);
        rb.setPadding(rb.getPaddingLeft(), p, 0, p);
        return rb;
    }

    private static LinearLayout pad(Activity a) {
        LinearLayout v = Ui.column(a);
        int p = Ui.dp(a, 22);
        v.setPadding(p, Ui.dp(a, 8), p, Ui.dp(a, 8));
        return v;
    }

    private static ScrollView scroll(Activity a, View v) {
        ScrollView sv = new ScrollView(a);
        sv.addView(v);
        return sv;
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

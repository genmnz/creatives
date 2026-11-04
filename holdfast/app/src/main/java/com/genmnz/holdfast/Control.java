package com.genmnz.holdfast;

import android.content.Context;
import android.net.Uri;

import java.util.List;

/**
 * One thing Holdfast can check and set. A control never acts by itself: the UI shows its
 * {@link Step}s, the user confirms one, and {@link Enforcer} runs it and re-reads to verify.
 */
abstract class Control {
    /** What a read found. {@code ok == null} means "can't tell". */
    static final class State {
        final String value;
        final Boolean ok;

        State(String value, Boolean ok) {
            this.value = value;
            this.ok = ok;
        }
    }

    final String id, module, title, about, effects, want;
    /** Can be kept enforced by the watchdog. False for things that are temporary by nature. */
    boolean holdable = true;
    /** Non-null if the control needs a value from the user (DNS host, country code). */
    String paramPrompt;
    /** Plain words for the UI: the status when private, the status when not, and the action. */
    String doneWord = "Off", todoWord = "On", verb = "Turn off";

    Control(String id, String module, String title, String want, String about, String effects) {
        this.id = id;
        this.module = module;
        this.title = title;
        this.want = want;
        this.about = about;
        this.effects = effects;
    }

    abstract State read(Context c);

    /** Every known way to reach the wanted state, strongest tier first. */
    abstract List<Step> apply(Context c);

    /** Every known way back to the value before Holdfast changed it. */
    abstract List<Step> restore(Context c);

    /** Content URIs that change when this control drifts, so the watchdog wakes immediately. */
    Uri[] watch() {
        return new Uri[0];
    }

    /** Hidden if it makes no sense on this device (package not installed, etc.). */
    boolean present(Context c) {
        return true;
    }

    /** What Restore should return to. Saved once, before Holdfast's first change. */
    String snapshot(Context c) {
        return read(c).value;
    }

    /** Status in plain words, e.g. "On — still active". */
    String human(State s) {
        if (s.ok == null) return "Can't tell";
        return s.ok ? doneWord : todoWord;
    }

    Control words(String done, String todo, String verb) {
        this.doneWord = done;
        this.todoWord = todo;
        this.verb = verb;
        return this;
    }

    String param(Context c) {
        return Store.param(c, id);
    }
}

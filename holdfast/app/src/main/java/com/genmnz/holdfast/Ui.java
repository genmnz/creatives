package com.genmnz.holdfast;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.res.TypedArray;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Tiny view helpers so the app needs no layout XML and no support libraries. */
final class Ui {
    static final int OK = 0xFF2E9E4F, BAD = 0xFFD9534F, UNKNOWN = 0xFF8A8F98;
    static final ExecutorService BG = Executors.newSingleThreadExecutor();
    static final Handler MAIN = new Handler(Looper.getMainLooper());

    private Ui() {}

    static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics()));
    }

    /** Runs work off the main thread, then the result on the main thread (if the activity is still alive). */
    interface Work<T> { T get() throws Exception; }
    interface Then<T> { void on(T value); }

    static <T> void bg(Activity a, Work<T> work, Then<T> then) {
        BG.execute(() -> {
            T v;
            try {
                v = work.get();
            } catch (Exception e) {
                MAIN.post(() -> toast(a, "Error: " + e.getMessage()));
                return;
            }
            MAIN.post(() -> {
                if (!a.isFinishing() && !a.isDestroyed()) then.on(v);
            });
        });
    }

    static ScrollView page(Activity a, LinearLayout body) {
        ScrollView sv = new ScrollView(a);
        sv.setFillViewport(true);
        body.setOrientation(LinearLayout.VERTICAL);
        int p = dp(a, 16);
        body.setPadding(p, p, p, dp(a, 32));
        sv.addView(body);
        a.setContentView(sv);
        return sv;
    }

    static LinearLayout column(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    static TextView text(Context c, CharSequence s, float sp) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextIsSelectable(false);
        return t;
    }

    static TextView heading(Context c, String s) {
        TextView t = text(c, s, 13);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setAllCaps(true);
        t.setLetterSpacing(0.06f);
        t.setTextColor(color(c, android.R.attr.colorAccent));
        t.setPadding(0, dp(c, 22), 0, dp(c, 6));
        return t;
    }

    static TextView mono(Context c, CharSequence s) {
        TextView t = text(c, s, 12);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextIsSelectable(true);
        int p = dp(c, 10);
        t.setPadding(p, p, p, p);
        t.setBackgroundColor(0x14808080);
        return t;
    }

    static TextView secondary(Context c, CharSequence s) {
        TextView t = text(c, s, 13);
        t.setTextColor(color(c, android.R.attr.textColorSecondary));
        return t;
    }

    static Button button(Context c, String label, View.OnClickListener l) {
        Button b = new Button(c);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    /** Buttons side by side, wrapping onto a new row when they don't fit. */
    static LinearLayout buttons(Context c, Button... bs) {
        LinearLayout col = column(c);
        LinearLayout row = null;
        for (int i = 0; i < bs.length; i++) {
            if (i % 2 == 0) {
                row = new LinearLayout(c);
                col.addView(row);
            }
            row.addView(bs[i], new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        }
        if (bs.length % 2 == 1 && row != null)
            row.addView(new View(c), new LinearLayout.LayoutParams(0, 1, 1));
        return col;
    }

    /** A "▸ label" line that shows or hides {@code content}. Content starts hidden. */
    static LinearLayout expander(Context c, String label, View content) {
        LinearLayout box = column(c);
        TextView t = text(c, "▸  " + label, 14);
        t.setTextColor(color(c, android.R.attr.colorAccent));
        int p = dp(c, 10);
        t.setPadding(0, p, 0, p);
        content.setVisibility(View.GONE);
        clickable(c, t, v -> {
            boolean show = content.getVisibility() != View.VISIBLE;
            content.setVisibility(show ? View.VISIBLE : View.GONE);
            t.setText((show ? "▾  " : "▸  ") + label);
        });
        box.addView(t);
        box.addView(content);
        return box;
    }

    /** A full-width button with an explanation line under it. */
    static LinearLayout action(Context c, String label, String explain, View.OnClickListener l) {
        LinearLayout box = column(c);
        box.addView(button(c, label, l), new LinearLayout.LayoutParams(-1, -2));
        if (explain != null) {
            TextView t = secondary(c, explain);
            t.setPadding(dp(c, 4), 0, dp(c, 4), dp(c, 8));
            box.addView(t);
        }
        return box;
    }

    static View clickable(Context c, View v, View.OnClickListener l) {
        TypedArray ta = c.obtainStyledAttributes(new int[]{android.R.attr.selectableItemBackground});
        v.setBackground(ta.getDrawable(0));
        ta.recycle();
        v.setOnClickListener(l);
        return v;
    }

    static int color(Context c, int attr) {
        TypedArray ta = c.obtainStyledAttributes(new int[]{attr});
        int v = ta.getColor(0, 0xFF888888);
        ta.recycle();
        return v;
    }

    static int stateColor(Boolean ok) {
        return ok == null ? UNKNOWN : ok ? OK : BAD;
    }

    static String stateMark(Boolean ok) {
        return ok == null ? "?" : ok ? "✓" : "✗";
    }

    static void copy(Context c, String label, String s) {
        c.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(label, s));
        toast(c, "Copied");
    }

    static void toast(Context c, String s) {
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
    }
}

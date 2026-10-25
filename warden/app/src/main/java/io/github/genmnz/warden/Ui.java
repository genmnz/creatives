package io.github.genmnz.warden;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

/**
 * Melad's tiny design kit: sections, rounded cards, rows with a control on the right,
 * on/off pills and roomy spacing. Follows the phone's light/dark mode. No libraries.
 */
final class Ui {
    final Context c;
    final boolean dark;
    final int bg, surface, text, sub, divider, accent, accentSoft, warn, warnSoft, bad, badSoft, off, offSoft;

    Ui(Context c) {
        this.c = c;
        dark = (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        bg = dark ? 0xFF0F1112 : 0xFFF3F5F4;
        surface = dark ? 0xFF1B1E20 : 0xFFFFFFFF;
        text = dark ? 0xFFECEFF1 : 0xFF15191C;
        sub = dark ? 0xFF9AA4AA : 0xFF5E6A70;
        divider = dark ? 0xFF2A2F33 : 0xFFE6EAEC;
        accent = dark ? 0xFF5BD08A : 0xFF1E7A46;
        accentSoft = dark ? 0xFF173A26 : 0xFFDDF3E6;
        warn = dark ? 0xFFF2C14E : 0xFF8A5A00;
        warnSoft = dark ? 0xFF3A3016 : 0xFFFFF1CF;
        bad = dark ? 0xFFFF7A70 : 0xFFB3261E;
        badSoft = dark ? 0xFF3D1A18 : 0xFFFDE2DF;
        off = dark ? 0xFFB0BAC0 : 0xFF5E6A70;
        offSoft = dark ? 0xFF2A2F33 : 0xFFE9EDEF;
    }

    int dp(int v) { return Math.round(v * c.getResources().getDisplayMetrics().density); }

    GradientDrawable shape(int color, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        return g;
    }

    /** Big page title + one-line subtitle. */
    void title(LinearLayout root, String title, String subtitle) {
        TextView t = tv(title, 30, text, true);
        root.addView(t);
        TextView s = tv(subtitle, 14, sub, false);
        s.setPadding(0, dp(4), 0, dp(16));
        root.addView(s);
    }

    /** Small uppercase label that starts a section. */
    void section(LinearLayout root, String name) {
        TextView t = tv(name.toUpperCase(java.util.Locale.ROOT), 12, sub, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(dp(4), dp(24), 0, dp(8));
        root.addView(t);
    }

    /** A rounded white/dark card; add rows to the returned layout. */
    LinearLayout card(LinearLayout root) {
        LinearLayout card = new LinearLayout(c);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(shape(surface, 18));
        card.setPadding(dp(16), dp(4), dp(16), dp(4));
        root.addView(card, new LinearLayout.LayoutParams(-1, -2));
        return card;
    }

    /** Row: title + explanation on the left, an optional control on the right. Returns the subtitle view. */
    TextView row(LinearLayout card, String title, String subtitle, View control) {
        if (card.getChildCount() > 0) divider(card);
        LinearLayout row = new LinearLayout(c);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(14), 0, dp(14));
        row.setMinimumHeight(dp(56));
        LinearLayout texts = new LinearLayout(c);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(tv(title, 16, text, false));
        TextView s = tv(subtitle == null ? "" : subtitle, 13, sub, false);
        s.setPadding(0, dp(3), 0, 0);
        if (subtitle == null) s.setVisibility(View.GONE);
        texts.addView(s);
        row.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
        if (control != null) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
            lp.leftMargin = dp(12);
            row.addView(control, lp);
        }
        card.addView(row);
        return s;
    }

    /** A row that opens something when tapped, with a chevron. */
    TextView link(LinearLayout card, String title, String subtitle, View.OnClickListener l) {
        TextView chev = tv("›", 26, sub, false);
        TextView s = row(card, title, subtitle, chev);
        View row = (View) chev.getParent();
        row.setOnClickListener(l);
        row.setBackground(null);
        return s;
    }

    void divider(LinearLayout card) {
        View d = new View(c);
        d.setBackgroundColor(divider);
        card.addView(d, new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2 + 1)));
    }

    Switch toggle(boolean on) {
        Switch s = new Switch(c);
        s.setChecked(on);
        return s;
    }

    enum State { ON, OFF, WARN, BAD }

    /** A small coloured pill: ON (green), OFF (grey), WARN (amber), BAD (red). */
    TextView pill(String label, State st) {
        TextView t = tv(label, 12, 0, true);
        t.setPadding(dp(10), dp(4), dp(10), dp(4));
        setPill(t, label, st);
        return t;
    }

    void setPill(TextView t, String label, State st) {
        t.setText(label);
        int fg, bgc;
        switch (st) {
            case ON: fg = accent; bgc = accentSoft; break;
            case WARN: fg = warn; bgc = warnSoft; break;
            case BAD: fg = bad; bgc = badSoft; break;
            default: fg = off; bgc = offSoft;
        }
        t.setTextColor(fg);
        t.setBackground(shape(bgc, 20));
    }

    /** Wide banner with a big status line and detail. */
    TextView[] banner(LinearLayout root) {
        LinearLayout b = new LinearLayout(c);
        b.setOrientation(LinearLayout.VERTICAL);
        b.setPadding(dp(18), dp(16), dp(18), dp(16));
        TextView head = tv("", 20, 0xFFFFFFFF, true);
        TextView detail = tv("", 14, 0xFFFFFFFF, false);
        detail.setAlpha(0.9f);
        detail.setPadding(0, dp(4), 0, 0);
        b.addView(head);
        b.addView(detail);
        root.addView(b, new LinearLayout.LayoutParams(-1, -2));
        return new TextView[]{head, detail};
    }

    void setBanner(TextView[] b, String head, String detail, State st) {
        int color = st == State.ON ? (dark ? 0xFF1F7A4A : 0xFF1E7A46)
                : st == State.WARN ? 0xFFB7791F : st == State.BAD ? 0xFFB3261E : (dark ? 0xFF3A4247 : 0xFF6B777D);
        ((View) b[0].getParent()).setBackground(shape(color, 20));
        b[0].setText(head);
        b[1].setText(detail);
        b[1].setVisibility(detail == null || detail.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** A soft-coloured notice inside the page (warnings, tips). */
    TextView notice(LinearLayout root, State st) {
        TextView t = tv("", 14, st == State.BAD ? bad : st == State.WARN ? warn : text, false);
        t.setBackground(shape(st == State.BAD ? badSoft : st == State.WARN ? warnSoft : accentSoft, 14));
        t.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(10);
        root.addView(t, lp);
        t.setVisibility(View.GONE);
        return t;
    }

    /** Flat buttons side by side inside a card. */
    void buttons(LinearLayout card, Object... labelThenListener) {
        if (card.getChildCount() > 0) divider(card);
        LinearLayout row = new LinearLayout(c);
        row.setPadding(0, dp(8), 0, dp(8));
        for (int i = 0; i + 1 < labelThenListener.length; i += 2) {
            Button b = new Button(c, null, android.R.attr.borderlessButtonStyle);
            b.setText((String) labelThenListener[i]);
            b.setAllCaps(false);
            b.setTextColor(accent);
            b.setTextSize(15);
            b.setOnClickListener((View.OnClickListener) labelThenListener[i + 1]);
            row.addView(b, new LinearLayout.LayoutParams(0, -2, 1));
        }
        card.addView(row);
    }

    TextView tv(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(sp);
        if (color != 0) t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    /** Page scaffold: scrolling, padded, themed background. Returns the content column. */
    LinearLayout page(android.app.Activity a) {
        LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(20), dp(16), dp(56));
        android.widget.ScrollView sv = new android.widget.ScrollView(c);
        sv.setFitsSystemWindows(true);
        sv.setBackgroundColor(bg);
        sv.addView(root, new ViewGroup.LayoutParams(-1, -2));
        a.setContentView(sv);
        a.getWindow().setStatusBarColor(bg);
        a.getWindow().setNavigationBarColor(bg);
        if (!dark) a.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        return root;
    }
}

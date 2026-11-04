package com.genmnz.holdfast;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import rikka.shizuku.Shizuku;

public class MainActivity extends Activity {
    private LinearLayout body;
    private LinearLayout list;
    private TextView privs;
    private final Shizuku.OnBinderReceivedListener onBinder = () -> Ui.MAIN.post(this::refresh);

    /** Things no app can do for you: account and Google-side settings. Ticked by you, shown as self-reported. */
    static final String[][] MANUAL = {
            {"gaid", "Delete the advertising ID", "Settings › Security and privacy › More privacy settings › Ads › Delete advertising ID.", "intent:com.google.android.gms.settings.ADS_PRIVACY"},
            {"adcenter", "Google My Ad Center: personalised ads off", "Ad geo-targeting mostly uses your IP and account history, not the phone.", "https://myadcenter.google.com/"},
            {"activity", "Google Timeline and Web & App Activity off", "Past locations and searches count as 'location of interest'.", "https://myactivity.google.com/activitycontrols"},
            {"samsung_ads", "Samsung customisation and ads toggles off", "Security and privacy › More privacy settings › Samsung: Customization service, news and offers, personalised ads, diagnostic data.", "intent:" + Settings.ACTION_PRIVACY_SETTINGS},
            {"meta", "Meta: remove profile city", "Meta targets 'living in or recently in' from profile, IP and friends.", "https://accountscenter.facebook.com/"},
            {"els", "Decide on Emergency Location Service", "Settings › Safety and emergency. Carrier emergency location still works either way.", "intent:" + Settings.ACTION_SETTINGS},
            {"findmy", "Decide on Find My Mobile / offline finding", "Settings › Security and privacy › Lost device protection. Off means no theft recovery.", "intent:" + Settings.ACTION_SECURITY_SETTINGS},
            {"wadb", "Wireless debugging off after setup", "Leave it on only while you use it.", "intent:" + Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS},
    };

    /** One-line plain explanation under each section heading. */
    static final String[][] INTROS = {
            {Controls.M_LOCATION, "Whether the phone works out where it is (GPS, Wi-Fi and cell positioning)."},
            {Controls.M_SCAN, "Background scans of nearby Wi-Fi and Bluetooth that phones use to find their position, even when Wi-Fi and Bluetooth look off."},
            {Controls.M_TIME, "Time-zone detection reads the cell network and your location."},
            {Controls.M_APPS, "Samsung background apps tied to location or ad profiles. Freezing is reversible. Needs Device Owner or Shizuku."},
            {Controls.M_NET, "Optional. Skip it if your ad-blocker already handles DNS."},
            {Controls.M_LOCKS, "Optional. Stops the switches above being turned back on at all. Needs Device Owner (advanced setup)."},
            {Controls.M_REGION, "Optional and temporary. Does not change your IP or where ads think you are."},
    };

    private TextView step1, step3;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        body = Ui.column(this);
        Ui.page(this, body);

        TextView t = Ui.text(this, "Holdfast", 26);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        body.addView(t);
        body.addView(Ui.secondary(this, "Stops your phone working out where you are, and keeps it that way. "
                + "Nothing changes until you confirm it."));

        LinearLayout start = Ui.column(this);
        int p = Ui.dp(this, 12);
        start.setPadding(p, p, p, p);
        start.setBackgroundColor(0x14808080);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = Ui.dp(this, 14);
        body.addView(start, lp);
        start.addView(Ui.heading(this, "Start here"));
        step1 = Ui.text(this, "", 15);
        start.addView(step1);
        start.addView(Ui.action(this, "Show me how", null, v -> startActivity(new Intent(this, SetupActivity.class))));
        start.addView(Ui.text(this, "2.  Turn off the recommended ones: location, Wi-Fi and Bluetooth scanning, time zone. "
                + "You tick each one.", 15));
        start.addView(Ui.action(this, "Turn off recommended…", null, v -> ControlUi.reviewAll(this, this::refresh)));
        step3 = Ui.text(this, "", 15);
        start.addView(step3);
        privs = Ui.secondary(this, "");
        start.addView(privs);

        body.addView(Ui.secondary(this, "\n✓ private already   ✗ still on   ? can't tell\n"
                + "Tap any row to see what it is, what changing it breaks, and to change it."));

        list = Ui.column(this);
        body.addView(list);

        body.addView(Ui.heading(this, "Apps"));
        body.addView(Ui.secondary(this, "Block location for single apps you don't trust."));
        body.addView(Ui.action(this, "Apps with location access", null, v -> startActivity(new Intent(this, AppsActivity.class))));

        body.addView(Ui.heading(this, "Do these yourself"));
        body.addView(Ui.secondary(this, "Ads find your area mostly from your internet address and your accounts, not the phone. "
                + "No app can change these, so tap Open, change it, then tick it."));
        for (String[] m : MANUAL) body.addView(manualRow(m));

        body.addView(Ui.heading(this, "What no app can hide"));
        body.addView(Ui.secondary(this, "Your internet (IP) address, which country the mobile network says you're in, "
                + "which cell tower you use, and emergency location. Only a VPN changes the IP."));

        body.addView(Ui.heading(this, "More"));
        body.addView(Ui.buttons(this,
                Ui.button(this, "Diagnostics", v -> startActivity(new Intent(this, DiagnosticsActivity.class))),
                Ui.button(this, "Setup", v -> startActivity(new Intent(this, SetupActivity.class)))));

        Shizuku.addBinderReceivedListenerSticky(onBinder);
    }

    @Override
    protected void onDestroy() {
        Shizuku.removeBinderReceivedListener(onBinder);
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    void refresh() {
        Ui.bg(this, () -> {
            Map<String, List<Object[]>> mods = new LinkedHashMap<>();
            for (String[] in : INTROS) mods.put(in[0], new ArrayList<>());
            for (Control c : Controls.all(this)) {
                if (c.id.startsWith("app:")) continue;
                mods.computeIfAbsent(c.module, k -> new ArrayList<>())
                        .add(new Object[]{c, c.read(this), Enforcer.pick(this, c) != null});
            }
            return new Object[]{Privs.now(this), mods};
        }, r -> {
            Privs pv = (Privs) r[0];
            @SuppressWarnings("unchecked") Map<String, List<Object[]>> mods = (Map<String, List<Object[]>>) r[1];
            step1.setText((pv.secure ? "1.  ✓ Permission given." : "1.  Give Holdfast permission. It's one command from a computer, once.")
                    + "");
            int done = 0;
            for (String[] m : MANUAL) if (Store.manual(this, m[0])) done++;
            step3.setText("\n3.  Do the account steps further down (" + done + " of " + MANUAL.length + " done).");
            privs.setText("\nPermissions Holdfast has: " + pv.summary().replace("   ", " · "));
            list.removeAllViews();
            for (String[] in : INTROS) {
                List<Object[]> rows = mods.get(in[0]);
                if (rows == null || rows.isEmpty()) continue;
                list.addView(Ui.heading(this, in[0]));
                list.addView(Ui.secondary(this, in[1]));
                for (Object[] row : rows) list.addView(row((Control) row[0], (Control.State) row[1], (Boolean) row[2]));
            }
        });
    }

    private View row(Control c, Control.State s, boolean canChange) {
        LinearLayout r = new LinearLayout(this);
        r.setGravity(Gravity.CENTER_VERTICAL);
        int p = Ui.dp(this, 8);
        r.setPadding(0, p, 0, p);
        TextView mark = Ui.text(this, Ui.stateMark(s.ok), 20);
        mark.setTextColor(Ui.stateColor(s.ok));
        mark.setTypeface(Typeface.DEFAULT_BOLD);
        mark.setGravity(Gravity.CENTER);
        r.addView(mark, new LinearLayout.LayoutParams(Ui.dp(this, 36), -2));
        LinearLayout col = Ui.column(this);
        col.addView(Ui.text(this, c.title, 16));
        boolean held = Store.isHeld(this, c.id);
        String line = c.human(s);
        if (held) line += " · Holdfast is watching it";
        else if (Boolean.FALSE.equals(s.ok)) line += canChange ? " · tap to " + c.verb.toLowerCase(java.util.Locale.ROOT)
                : " · needs more permission";
        int d = Store.drifts(this, c.id);
        if (d > 0) line += " · changed back " + d + "×";
        TextView sub = Ui.secondary(this, line);
        if (Boolean.FALSE.equals(s.ok)) sub.setTextColor(Ui.BAD);
        col.addView(sub);
        r.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        return Ui.clickable(this, r, v -> ControlUi.details(this, c, this::refresh));
    }

    private View manualRow(String[] m) {
        LinearLayout r = new LinearLayout(this);
        r.setGravity(Gravity.CENTER_VERTICAL);
        CheckBox cb = new CheckBox(this);
        cb.setChecked(Store.manual(this, m[0]));
        cb.setOnCheckedChangeListener((x, on) -> {
            Store.manual(this, m[0], on);
            EventLog.add(this, "MANUAL", m[0], on ? "you marked it done" : "you unmarked it");
            refresh();
        });
        r.addView(cb);
        LinearLayout col = Ui.column(this);
        col.addView(Ui.text(this, m[1], 15));
        col.addView(Ui.secondary(this, m[2]));
        r.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        r.addView(Ui.button(this, "Open", v -> ControlUi.open(this, m[3].startsWith("intent:")
                ? new Intent(m[3].substring(7))
                : new Intent(Intent.ACTION_VIEW, Uri.parse(m[3])))));
        int p = Ui.dp(this, 4);
        r.setPadding(0, p, 0, p);
        return r;
    }
}

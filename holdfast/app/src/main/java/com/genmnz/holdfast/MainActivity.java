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

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        body = Ui.column(this);
        Ui.page(this, body);

        TextView t = Ui.text(this, "Holdfast", 26);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        body.addView(t);
        body.addView(Ui.secondary(this, "Turns off the phone's location signals and keeps them off. "
                + "Every change shows exactly what will run and waits for you."));

        privs = Ui.text(this, "", 14);
        int p = Ui.dp(this, 12);
        privs.setPadding(p, p, p, p);
        privs.setBackgroundColor(0x14808080);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = Ui.dp(this, 14);
        body.addView(Ui.clickable(this, privs, v -> startActivity(new Intent(this, SetupActivity.class))), lp);

        body.addView(Ui.buttons(this,
                Ui.button(this, "Review all…", v -> ControlUi.reviewAll(this, this::refresh)),
                Ui.button(this, "Per-app location", v -> startActivity(new Intent(this, AppsActivity.class))),
                Ui.button(this, "Diagnostics", v -> startActivity(new Intent(this, DiagnosticsActivity.class))),
                Ui.button(this, "Privileges", v -> startActivity(new Intent(this, SetupActivity.class)))));

        list = Ui.column(this);
        body.addView(list);

        body.addView(Ui.heading(this, "Do these yourself"));
        body.addView(Ui.secondary(this, "No app can change these. Tick them when done; Diagnostics shows them as self-reported."));
        for (String[] m : MANUAL) body.addView(manualRow(m));

        body.addView(Ui.heading(this, "Out of reach without root or a VPN"));
        body.addView(Ui.secondary(this, "The network country (cell MCC), your carrier or Wi-Fi IP, the carrier's view of your cell, "
                + "and emergency network location. Ads are placed mostly by IP and account history, so finish the list above. "
                + "Diagnostics › 'Where Android thinks you are' shows each source."));

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
            for (Control c : Controls.all(this)) {
                if (c.id.startsWith("app:")) continue;
                mods.computeIfAbsent(c.module, k -> new ArrayList<>()).add(new Object[]{c, c.read(this)});
            }
            return new Object[]{Privs.now(this), mods};
        }, r -> {
            Privs pv = (Privs) r[0];
            @SuppressWarnings("unchecked") Map<String, List<Object[]>> mods = (Map<String, List<Object[]>>) r[1];
            privs.setText(pv.summary().replace("   ", "\n") + "\nTap to see how to get the missing ones.");
            list.removeAllViews();
            for (Map.Entry<String, List<Object[]>> e : mods.entrySet()) {
                list.addView(Ui.heading(this, e.getKey()));
                for (Object[] row : e.getValue()) list.addView(row((Control) row[0], (Control.State) row[1]));
            }
        });
    }

    private View row(Control c, Control.State s) {
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
        TextView title = Ui.text(this, c.title, 16);
        col.addView(title);
        String held = Store.isHeld(this, c.id)
                ? " · held, " + (Store.AUTO.equals(Store.mode(this, c.id)) ? "auto-fix" : "asks") : "";
        int d = Store.drifts(this, c.id);
        col.addView(Ui.secondary(this, "now " + s.value + held + (d > 0 ? " · changed back " + d + "×" : "")));
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

package com.genmnz.holdfast;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.TextView;

import rikka.shizuku.Shizuku;

/** Step-by-step setup in plain words. Holdfast never grants itself anything. */
public class SetupActivity extends Activity {
    static final String DO_CMD = "adb shell dpm set-device-owner com.genmnz.holdfast/.AdminReceiver";
    static final String WSS_CMD = "adb shell pm grant com.genmnz.holdfast android.permission.WRITE_SECURE_SETTINGS";

    private LinearLayout body;
    private final Shizuku.OnRequestPermissionResultListener onShizuku = (code, result) -> Ui.MAIN.post(this::build);
    private final Shizuku.OnBinderReceivedListener onBinder = () -> Ui.MAIN.post(this::build);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setTitle("Setup");
        body = Ui.column(this);
        Ui.page(this, body);
        Shizuku.addRequestPermissionResultListener(onShizuku);
        Shizuku.addBinderReceivedListener(onBinder);
    }

    @Override
    protected void onDestroy() {
        Shizuku.removeRequestPermissionResultListener(onShizuku);
        Shizuku.removeBinderReceivedListener(onBinder);
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        body.removeAllViews();
        Privs p = Privs.now(this);

        // ---- required
        status("Needed: permission to change settings", p.secure,
                "Lets Holdfast turn off location, Wi-Fi and Bluetooth scanning, assisted GPS, time zone detection and "
                        + "set Private DNS. Android only gives this through one command from a computer. You do it once; "
                        + "it lasts through reboots. Uninstalling Holdfast removes it.");
        if (!p.secure) {
            body.addView(Ui.heading(this, "On the phone"));
            steps(1,
                    "Settings › About phone › Software information › tap Build number 7 times and enter your PIN. "
                            + "This turns on Developer options.",
                    "Settings › Developer options › turn on USB debugging.",
                    "If Auto Blocker is on (Settings › Security and privacy › Auto Blocker), turn it off for now. "
                            + "It blocks commands over USB.");
            body.addView(Ui.heading(this, "On a computer (Windows, Mac or Linux)"));
            steps(4,
                    "Download Google's \"SDK Platform-Tools\" and unzip it.",
                    "Plug the phone in with a USB cable. Open a terminal (Windows: PowerShell) in the unzipped "
                            + "platform-tools folder.",
                    "Type  adb devices  and press Enter. On the phone, tap Allow.",
                    "Type this command and press Enter (on Windows start it with .\\adb instead of adb):");
            TextView m = Ui.mono(this, WSS_CMD);
            m.setTypeface(Typeface.MONOSPACE);
            body.addView(m);
            body.addView(Ui.buttons(this,
                    Ui.button(this, "Copy command", v -> Ui.copy(this, "command", WSS_CMD)),
                    Ui.button(this, "Platform-Tools page", v -> ControlUi.open(this, new Intent(Intent.ACTION_VIEW,
                            Uri.parse("https://developer.android.com/tools/releases/platform-tools"))))));
            steps(8, "Come back to this screen. The heading turns ✓. Then turn Auto Blocker back on and USB debugging off.");
        } else {
            body.addView(Ui.secondary(this, "Done. You can turn USB debugging off and Auto Blocker back on."));
        }

        // ---- optional
        body.addView(Ui.heading(this, "Optional"));
        status("Samsung settings permission", p.system,
                "Only for the two Samsung nearby-scanning switches. Samsung may refuse even with it; Holdfast will tell you.");
        if (!p.system) body.addView(Ui.action(this, "Open the switch",
                "Turn on \"Allow permission\" for Holdfast, then come back.", v -> ControlUi.open(this,
                        new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getPackageName())))));

        boolean notif = getSystemService(NotificationManager.class).areNotificationsEnabled();
        status("Notifications", notif,
                "So Holdfast can tell you when something turns a setting back on. Without it, watching still works but "
                        + "can only fix things automatically.");
        if (!notif) body.addView(Ui.action(this, "Open notification settings", null, v -> ControlUi.open(this,
                new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()))));

        status("Shizuku (separate app)", p.shizuku,
                "Needed to freeze Samsung background apps and to block location for single apps. Shizuku is a separate "
                        + "free app that must be started again after every reboot. Skip it if you don't need those.\n"
                        + "Status: " + Shell.describe() + ".\n"
                        + "On Android 17 use an up-to-date build (thedjchi's Shizuku or Shizuku+), not the old Play Store one.");
        if (Shell.binder() && !p.shizuku)
            body.addView(Ui.action(this, "Allow Holdfast in Shizuku", null, v -> {
                try {
                    Shizuku.requestPermission(1);
                } catch (Throwable t) {
                    Ui.toast(this, "Shizuku: " + t.getMessage());
                }
            }));

        // ---- advanced
        body.addView(Ui.heading(this, "Advanced: not recommended yet"));
        status("Device Owner", p.deviceOwner,
                "The strongest permission: lets Holdfast lock switches so they can't be turned back on, freeze apps "
                        + "and block app permissions without Shizuku.");
        TextView warn = Ui.text(this, "Before you consider it:\n"
                + "• Setting it up means deleting Secure Folder, work profiles and Dual Messenger copies, with their data, "
                + "and signing out of all accounts first.\n"
                + "• A Device Owner app can't be uninstalled the normal way. If Holdfast misbehaves, getting rid of it "
                + "may need a factory reset.\n"
                + "• Holdfast hasn't been tested on a One UI 9 phone yet. Use the steps above first.", 14);
        warn.setTextColor(Ui.BAD);
        body.addView(warn);
        if (p.deviceOwner) {
            body.addView(Ui.action(this, "Remove Device Owner…",
                    "Android then removes the locks Holdfast set and unfreezes the apps it froze.", v -> new AlertDialog.Builder(this)
                            .setTitle("Remove Device Owner?")
                            .setMessage("Android will remove the locks Holdfast set and unfreeze the apps it froze. "
                                    + "Settings Holdfast turned off (scanning, assisted GPS) stay off. "
                                    + "Getting Device Owner back needs a computer again.")
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton("Remove", (d, w) -> {
                                try {
                                    //noinspection deprecation
                                    Privs.dpm(this).clearDeviceOwnerApp(getPackageName());
                                    EventLog.add(this, "PRIVILEGE", "-", "Device Owner removed by you");
                                } catch (Exception e) {
                                    Ui.toast(this, "Failed: " + e.getMessage());
                                }
                                build();
                            }).show()));
        } else {
            LinearLayout how = Ui.column(this);
            how.addView(Ui.text(this, "With every account removed, Secure Folder/work profile/Dual Messenger deleted, "
                    + "Auto Blocker off and USB debugging on, run:", 14));
            how.addView(Ui.mono(this, DO_CMD));
            how.addView(Ui.button(this, "Copy command", v -> Ui.copy(this, "command", DO_CMD)));
            how.addView(Ui.secondary(this, "Then sign back in to your accounts."));
            body.addView(Ui.expander(this, "Show how anyway", how));
        }

        // ---- safety
        body.addView(Ui.heading(this, "Safety check"));
        TextView patch = Ui.text(this, "…", 14);
        body.addView(patch);
        Ui.bg(this, () -> "Security update: " + Probe.patchVerdict() + "\nWireless debugging: "
                        + ("1".equals(Sx.get(this, Sx.GLOBAL, "adb_wifi_enabled")) ? "ON. Turn it off when you're done." : "off ✓"),
                patch::setText);
    }

    private void status(String title, boolean ok, String about) {
        TextView h = Ui.text(this, (ok ? "✓  " : "○  ") + title, 17);
        h.setTypeface(Typeface.DEFAULT_BOLD);
        if (ok) h.setTextColor(Ui.OK);
        h.setPadding(0, Ui.dp(this, 18), 0, Ui.dp(this, 4));
        body.addView(h);
        body.addView(Ui.text(this, about, 14));
    }

    private void steps(int first, String... lines) {
        for (int i = 0; i < lines.length; i++) {
            TextView t = Ui.text(this, (first + i) + ".  " + lines[i], 14);
            t.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 4));
            body.addView(t);
        }
    }
}

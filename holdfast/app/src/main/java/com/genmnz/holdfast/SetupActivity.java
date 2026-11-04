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

/** How to get each privilege tier, with the exact command to copy. Holdfast never grants itself anything. */
public class SetupActivity extends Activity {
    static final String DO_CMD = "adb shell dpm set-device-owner com.genmnz.holdfast/.AdminReceiver";
    static final String WSS_CMD = "adb shell pm grant com.genmnz.holdfast android.permission.WRITE_SECURE_SETTINGS";

    private LinearLayout body;
    private final Shizuku.OnRequestPermissionResultListener onShizuku = (code, result) -> Ui.MAIN.post(this::build);
    private final Shizuku.OnBinderReceivedListener onBinder = () -> Ui.MAIN.post(this::build);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
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
        body.addView(Ui.secondary(this, "Holdfast uses whichever of these you give it, strongest first. "
                + "Two are a one-time adb command from a computer; nothing here runs by itself."));

        section("Device Owner", p.deviceOwner,
                "Strongest. Policies survive reboots and system updates, and can lock location and date & time settings. "
                        + "Before running the command:\n"
                        + "• Remove every account (Samsung, Google…) in Settings › Accounts, or setting it fails with “already some accounts on the device”. Sign back in afterwards.\n"
                        + "• Delete Secure Folder, any work profile, private space, other users and Dual Messenger clones.\n"
                        + "• Turn Auto Blocker off (Security and privacy › Auto Blocker): it blocks USB commands and device-admin activation.\n"
                        + "• USB debugging on (Developer options; dial *#0808# and pick MTP + ADB if adb can't see the phone).",
                DO_CMD);
        if (p.deviceOwner) body.addView(Ui.button(this, "Remove Device Owner…", v -> new AlertDialog.Builder(this)
                .setTitle("Remove Device Owner?")
                .setMessage("Android will clear the restrictions Holdfast set (location and date & time locks) and unsuspend "
                        + "the apps it suspended. Settings written directly (scanning, A-GPS) stay as they are. "
                        + "You need adb again to get Device Owner back.")
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

        section("Secure settings grant", p.secure,
                "Lets Holdfast write scanning, A-GPS, time zone and DNS keys by itself, with no Shizuku. Survives reboot. "
                        + "Device Owner does not include this; grant it too.",
                WSS_CMD);

        section("Modify system settings", p.system,
                "Needed only for Samsung nearby scanning keys. Samsung may still refuse private keys; then Shizuku is the fallback.",
                null);
        if (!p.system) body.addView(Ui.button(this, "Open the switch", v -> ControlUi.open(this,
                new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getPackageName())))));

        section("Shizuku shell (optional)", p.shizuku,
                "Status: " + Shell.describe() + ".\nFor shell-only things: app ops, disabling packages, time zone detector, "
                        + "SIM country. Must be restarted after each reboot; Holdfast keeps enforcing through the tiers above meanwhile. "
                        + "On Android 17 QPR1+ use a fork that handles the adb_enabled change (thedjchi Shizuku, Shizuku+).",
                null);
        if (Shell.binder() && !p.shizuku)
            body.addView(Ui.button(this, "Ask Shizuku for permission", v -> {
                try {
                    Shizuku.requestPermission(1);
                } catch (Throwable t) {
                    Ui.toast(this, "Shizuku: " + t.getMessage());
                }
            }));

        boolean notif = getSystemService(NotificationManager.class).areNotificationsEnabled();
        section("Notifications", notif, "Used to ask before re-applying a held setting that changed back.", null);
        if (!notif) body.addView(Ui.button(this, "Open notification settings", v -> ControlUi.open(this,
                new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()))));

        body.addView(Ui.heading(this, "Safety"));
        TextView patch = Ui.text(this, "Security patch: …", 14);
        body.addView(patch);
        Ui.bg(this, () -> Probe.patchVerdict() + "\nWireless debugging: "
                + ("1".equals(Sx.get(this, Sx.GLOBAL, "adb_wifi_enabled")) ? "ON. Turn it off once setup is done." : "off"),
                patch::setText);
    }

    private void section(String title, boolean ok, String about, String cmd) {
        TextView h = Ui.heading(this, (ok ? "✓ " : "✗ ") + title);
        h.setTextColor(ok ? Ui.OK : Ui.color(this, android.R.attr.colorAccent));
        body.addView(h);
        body.addView(Ui.text(this, about, 14));
        if (cmd != null && !ok) {
            TextView m = Ui.mono(this, cmd);
            m.setTypeface(Typeface.MONOSPACE);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = Ui.dp(this, 8);
            body.addView(m, lp);
            body.addView(Ui.button(this, "Copy command", v -> Ui.copy(this, title, cmd)));
        }
    }
}

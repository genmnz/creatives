package com.genmnz.holdfast;

/** A way Holdfast can get the right to change something. Ordered strongest first. */
enum Tier {
    DEVICE_OWNER("Device Owner", "Set once with adb: dpm set-device-owner. Survives reboot and updates."),
    SECURE_SETTINGS("Secure settings grant", "Granted once with adb: pm grant … WRITE_SECURE_SETTINGS. Survives reboot."),
    SYSTEM_SETTINGS("Modify system settings", "Special app access you can toggle in Settings."),
    SHIZUKU("Shizuku shell", "Runs a shell command as uid 2000. Shizuku must be running (restart it after every reboot).");

    final String label;
    final String how;

    Tier(String label, String how) {
        this.label = label;
        this.how = how;
    }
}

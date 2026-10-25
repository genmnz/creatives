package io.github.genmnz.warden;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * If Melad ever crashes, the reason is saved on the phone (never sent anywhere).
 * Next time you open the app it offers the report with a Copy button, so you can
 * paste it to whoever is fixing it.
 */
final class CrashLog {
    private static boolean installed;

    private CrashLog() {}

    private static File file(Context c) { return new File(c.getFilesDir(), "crash.txt"); }

    static synchronized void install(Context c) {
        if (installed) return;
        installed = true;
        final Context app = c.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                StringWriter sw = new StringWriter();
                PrintWriter pw = new PrintWriter(sw);
                pw.println("Melad crash report");
                pw.println("time: " + new java.util.Date());
                pw.println("android: " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
                pw.println("phone: " + Build.MANUFACTURER + " " + Build.MODEL);
                pw.println("thread: " + t.getName());
                e.printStackTrace(pw);
                pw.flush();
                try (FileOutputStream o = new FileOutputStream(file(app))) {
                    o.write(sw.toString().getBytes(StandardCharsets.UTF_8));
                }
            } catch (Throwable ignored) {
            }
            if (previous != null) previous.uncaughtException(t, e);
        });
    }

    /** Shows the saved report once (with Copy), then deletes it. */
    static void offer(Activity a) {
        File f = file(a);
        if (!f.exists()) return;
        String text;
        try {
            text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            f.delete();
            return;
        }
        f.delete();
        final String report = text;
        new AlertDialog.Builder(a).setTitle("Melad stopped last time")
                .setMessage("Sorry about that. Copy this report and send it so it can be fixed:\n\n"
                        + (report.length() > 1500 ? report.substring(0, 1500) + "…" : report))
                .setPositiveButton("Copy report", (d, w) -> {
                    ClipboardManager cm = a.getSystemService(ClipboardManager.class);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Melad crash", report));
                })
                .setNegativeButton("Dismiss", null).show();
    }
}

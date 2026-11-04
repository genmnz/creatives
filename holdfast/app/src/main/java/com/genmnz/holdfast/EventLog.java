package com.genmnz.holdfast;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Append-only text log of every action, verification and drift. Kept under ~256 KB. */
final class EventLog {
    private static final long MAX = 256 * 1024;

    private EventLog() {}

    static String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    static synchronized void add(Context c, String kind, String id, String msg) {
        File f = file(c);
        String line = now() + "  " + kind + "  " + id + "  " + msg.replace("\n", "\n        ") + "\n";
        try {
            if (f.length() > MAX) trim(f);
            try (FileOutputStream o = new FileOutputStream(f, true)) {
                o.write(line.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
        }
    }

    static synchronized String tail(Context c, int maxChars) {
        File f = file(c);
        if (!f.exists()) return "(no events yet)";
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            long start = Math.max(0, r.length() - maxChars);
            r.seek(start);
            byte[] b = new byte[(int) (r.length() - start)];
            r.readFully(b);
            String s = new String(b, StandardCharsets.UTF_8);
            if (start > 0) s = "…" + s.substring(Math.max(0, s.indexOf('\n') + 1));
            return s;
        } catch (Exception e) {
            return "(log unreadable: " + e + ")";
        }
    }

    static synchronized void clear(Context c) {
        //noinspection ResultOfMethodCallIgnored
        file(c).delete();
    }

    private static void trim(File f) throws Exception {
        byte[] all = Files.readAllBytes(f.toPath());
        int from = all.length / 2;
        while (from < all.length && all[from] != '\n') from++;
        try (FileOutputStream o = new FileOutputStream(f, false)) {
            o.write(all, Math.min(from + 1, all.length), Math.max(0, all.length - from - 1));
        }
    }

    private static File file(Context c) {
        return new File(c.getFilesDir(), "events.log");
    }
}

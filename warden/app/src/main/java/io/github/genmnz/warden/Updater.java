package io.github.genmnz.warden;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads the chosen blocklists so they stay current, the way an ad blocker
 * refreshes EasyList. Runs off the main thread; writes each list atomically.
 * No analytics, no account — Warden only fetches the public list text.
 */
final class Updater {
    private Updater() {}

    interface Progress {
        void line(String msg);
        void done(String summary);
    }

    static long lastUpdate(Context c) { return Store.prefs(c).getLong("lists_updated", 0); }

    /** True once a day has passed; used for the optional auto-update on connect. */
    static boolean due(Context c) {
        return System.currentTimeMillis() - lastUpdate(c) > 24L * 3600_000L;
    }

    /** Updates every enabled source that has a URL. Returns a short summary. */
    static String updateAll(Context c, Progress p) {
        int ok = 0, fail = 0, total = 0;
        StringBuilder problems = new StringBuilder();
        for (Store.Source s : Store.SOURCES) {
            if (s.url == null || !Store.enabled(c, s)) continue;
            total++;
            if (p != null) p.line("Updating " + s.label + "…");
            try {
                int n = fetch(s.url, Store.cacheFile(c, s));
                if (p != null) p.line(s.label + ": " + n + " rules");
                ok++;
            } catch (IOException e) {
                fail++;
                problems.append('\n').append(s.label).append(": ").append(e.getMessage());
            }
        }
        if (ok > 0) {
            Store.prefs(c).edit().putLong("lists_updated", System.currentTimeMillis()).apply();
            try {
                int rules = Store.compile(c);
                Engine e = Engine.running;
                if (e != null) e.reloadLists();
                String summary = "Updated " + ok + "/" + total + " lists · " + String.format(java.util.Locale.ROOT, "%,d", rules) + " rules" + problems;
                if (p != null) p.done(summary);
                return summary;
            } catch (IOException e) {
                String msg = "Rebuild failed: " + e.getMessage();
                if (p != null) p.done(msg);
                return msg;
            }
        }
        String msg = fail == 0 ? "Nothing to update" : "Update failed" + problems;
        if (p != null) p.done(msg);
        return msg;
    }

    /** Downloads one list to a temp file, validates it parses, then renames it into place. */
    static int fetch(String url, File dest) throws IOException {
        HttpURLConnection con = null;
        File tmp = new File(dest.getPath() + ".tmp");
        try {
            con = (HttpURLConnection) new URL(url).openConnection();
            con.setRequestProperty("User-Agent", "Melad-privacy-app/2.0");
            con.setConnectTimeout(15000);
            con.setReadTimeout(30000);
            con.setInstanceFollowRedirects(true);
            int code = con.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            long max = 16L * 1024 * 1024;
            long written = 0;
            try (InputStream in = new BufferedInputStream(con.getInputStream(), 65536);
                 FileOutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                for (int r; (r = in.read(buf)) > 0; ) {
                    out.write(buf, 0, r);
                    written += r;
                    if (written > max) throw new IOException("list too large");
                }
            }
            int rules;
            Blocklist.Builder b = new Blocklist.Builder();
            try (InputStream in = new java.io.FileInputStream(tmp)) { rules = b.parse(in); }
            if (rules < 5) throw new IOException("list looks empty");
            if (!tmp.renameTo(dest)) throw new IOException("save failed");
            tmp = null;
            return rules;
        } finally {
            if (con != null) con.disconnect();
            if (tmp != null) tmp.delete();
        }
    }
}

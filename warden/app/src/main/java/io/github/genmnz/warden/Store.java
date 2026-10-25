package io.github.genmnz.warden;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

/** Settings, the block/allow list catalogue, and the compiled lists. Everything stays on the phone. */
final class Store {
    /**
     * A blocklist category. Each ships with an up-to-date copy inside the app (`asset`,
     * a gzipped domain list), and most can refresh themselves from a public list (`url`)
     * — the same lists ad blockers like uBlock Origin and AdGuard use. Nothing is sent
     * anywhere; Warden only downloads the list text.
     */
    static final class Source {
        final String id, label, desc, asset, url;
        final boolean onByDefault;

        Source(String id, String label, String desc, String asset, String url, boolean onByDefault) {
            this.id = id;
            this.label = label;
            this.desc = desc;
            this.asset = asset;
            this.url = url;
            this.onByDefault = onByDefault;
        }
    }

    // Sources are HaGeZi's lists (CC0), mirrored on Codeberg/GitLab so no single host is required,
    // plus a hand-made location list. "light" is the size-optimised ads+trackers+telemetry set.
    private static final String HAGEZI = "https://codeberg.org/hagezi/mirror2/raw/branch/main/dns-blocklists/";

    static final Source[] SOURCES = {
            new Source("telemetry", "Ads, trackers & telemetry",
                    "The main list: ads, analytics, crash/usage reporting and tracking across apps and the web (HaGeZi Light).",
                    "telemetry.txt.gz", HAGEZI + "wildcard/light-onlydomains.txt", true),
            new Source("location", "Location lookups",
                    "Wi-Fi/cell geolocation and assisted-GPS servers. GPS still works; first fix can be slower.",
                    "location.txt.gz", null, true),
            new Source("device", "Device & carrier trackers",
                    "Built-in trackers from Samsung, Xiaomi, Apple, Amazon, Microsoft and TikTok (HaGeZi native trackers).",
                    "device.txt.gz", HAGEZI + "domains/native.samsung.txt", true),
            new Source("doh", "Block encrypted-DNS bypass",
                    "Public DNS-over-HTTPS servers apps use to dodge this filter (HaGeZi DNS bypass). Reinforces 'catch hardcoded DNS'.",
                    "doh.txt.gz", HAGEZI + "domains/doh.txt", true),
            new Source("extra", "Stronger blocking (bigger)",
                    "HaGeZi Pro: more aggressive, blocks more but may break the odd site. Downloaded on first use.",
                    null, HAGEZI + "wildcard/pro-onlydomains.txt", false),
            new Source("annoyance", "Annoyances & pop-ups",
                    "Cookie notices, in-app nags, pop-ups (AdGuard annoyances). Downloaded on first use.",
                    null, "https://codeberg.org/hagezi/mirror2/raw/branch/main/dns-blocklists/wildcard/popupads-onlydomains.txt", false),
    };

    private Store() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("warden", Context.MODE_PRIVATE);
    }

    static boolean enabled(Context c, Source s) { return prefs(c).getBoolean("cat_" + s.id, s.onByDefault); }

    static File importsDir(Context c) {
        File d = new File(c.getFilesDir(), "imports");
        d.mkdirs();
        return d;
    }

    static File cacheDir(Context c) {
        File d = new File(c.getFilesDir(), "lists");
        d.mkdirs();
        return d;
    }

    /** Downloaded copy of a source's list, newer than the bundled one when present. */
    static File cacheFile(Context c, Source s) { return new File(cacheDir(c), s.id + ".txt"); }

    static File blockFile(Context c) { return new File(c.getFilesDir(), "block.bin"); }

    static File allowFile(Context c) { return new File(c.getFilesDir(), "allow.bin"); }

    static Source source(String id) {
        for (Source s : SOURCES) if (s.id.equals(id)) return s;
        return null;
    }

    /** Opens a source's freshest list: a downloaded copy if present, else the bundled asset. */
    static InputStream openSource(Context c, Source s) throws IOException {
        File cache = cacheFile(c, s);
        if (cache.exists()) return new FileInputStream(cache);
        if (s.asset != null) {
            InputStream in = c.getAssets().open("lists/" + s.asset);
            return s.asset.endsWith(".gz") ? new GZIPInputStream(in) : in;
        }
        return new ByteArrayInputStream(new byte[0]);
    }

    /** Rebuilds block.bin / allow.bin from the enabled sources, imports and the user's own lists. */
    static int compile(Context c) throws IOException {
        SharedPreferences p = prefs(c);
        Blocklist.Builder block = new Blocklist.Builder();
        int rules = 0;
        for (Source s : SOURCES) {
            if (!enabled(c, s)) continue;
            try (InputStream in = openSource(c, s)) { rules += block.parse(in); }
        }
        File[] imports = importsDir(c).listFiles();
        if (imports != null) {
            for (File f : imports) {
                try (InputStream in = new FileInputStream(f)) { rules += block.parse(in); }
            }
        }
        rules += block.parse(text(p.getString("user_block", "")));
        Blocklist.Builder allow = new Blocklist.Builder();
        try (InputStream in = c.getAssets().open("lists/allow.txt")) { allow.parse(in); }
        allow.parse(text(p.getString("user_allow", "")));
        Blocklist.save(blockFile(c), block.sorted());
        Blocklist.save(allowFile(c), allow.sorted());
        p.edit().putInt("rules", rules).apply();
        return rules;
    }

    static Blocklist load(Context c) throws IOException {
        if (!blockFile(c).exists()) compile(c);
        return new Blocklist(Blocklist.load(blockFile(c)), Blocklist.load(allowFile(c)));
    }

    private static InputStream text(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}

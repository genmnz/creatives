package io.github.genmnz.warden;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Settings and the compiled block/allow lists. Everything stays on the phone. */
final class Store {
    static final String[][] CATEGORIES = {
            {"telemetry", "Telemetry & analytics", "App and OS tracking, crash/usage reporting"},
            {"location", "Location services", "Wi-Fi/cell geolocation and A-GPS helpers. GPS still works, first fix can be slower"},
            {"samsung", "Samsung & carrier", "Samsung diagnostics, ads and carrier customisation servers"},
    };

    private Store() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("warden", Context.MODE_PRIVATE);
    }

    static boolean category(Context c, String id) { return prefs(c).getBoolean("cat_" + id, true); }

    static File importsDir(Context c) {
        File d = new File(c.getFilesDir(), "imports");
        d.mkdirs();
        return d;
    }

    static File blockFile(Context c) { return new File(c.getFilesDir(), "block.bin"); }

    static File allowFile(Context c) { return new File(c.getFilesDir(), "allow.bin"); }

    /** Rebuilds block.bin / allow.bin from the enabled sources. Returns number of block rules read. */
    static int compile(Context c) throws IOException {
        SharedPreferences p = prefs(c);
        Blocklist.Builder block = new Blocklist.Builder();
        int rules = 0;
        for (String[] cat : CATEGORIES) {
            if (!category(c, cat[0])) continue;
            try (InputStream in = c.getAssets().open("lists/" + cat[0] + ".txt")) { rules += block.parse(in); }
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

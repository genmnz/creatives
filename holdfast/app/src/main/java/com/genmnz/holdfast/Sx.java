package com.genmnz.holdfast;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.Looper;
import android.provider.Settings;

/** Settings provider access with a shell fallback for keys the app isn't allowed to read. */
final class Sx {
    static final int GLOBAL = 0, SECURE = 1, SYSTEM = 2;
    private static final String[] NS = {"global", "secure", "system"};
    private static final String[] CLS = {"Settings.Global", "Settings.Secure", "Settings.System"};

    static final class Val {
        final String raw;
        final boolean readable;
        final String via;

        Val(String raw, boolean readable, String via) {
            this.raw = raw;
            this.readable = readable;
            this.via = via;
        }
    }

    private Sx() {}

    static String ns(int ns) {
        return NS[ns];
    }

    static String cls(int ns) {
        return CLS[ns];
    }

    static Val read(Context c, int ns, String key) {
        try {
            return new Val(direct(c.getContentResolver(), ns, key), true, "app");
        } catch (SecurityException e) {
            if (Shell.permitted() && Looper.myLooper() != Looper.getMainLooper()) {
                try {
                    Shell.Result r = Shell.run(c, "settings get " + NS[ns] + " " + key);
                    String v = r.out.trim();
                    return new Val("null".equals(v) ? null : v, r.exit == 0, "shell");
                } catch (Exception ignored) {
                }
            }
            return new Val(null, false, "blocked: " + e.getMessage());
        }
    }

    static String get(Context c, int ns, String key) {
        Val v = read(c, ns, key);
        return v.readable ? v.raw : null;
    }

    private static String direct(ContentResolver cr, int ns, String key) {
        switch (ns) {
            case GLOBAL: return Settings.Global.getString(cr, key);
            case SECURE: return Settings.Secure.getString(cr, key);
            default: return Settings.System.getString(cr, key);
        }
    }

    static void put(Context c, int ns, String key, String v) throws Exception {
        ContentResolver cr = c.getContentResolver();
        boolean ok;
        switch (ns) {
            case GLOBAL: ok = Settings.Global.putString(cr, key, v); break;
            case SECURE: ok = Settings.Secure.putString(cr, key, v); break;
            default: ok = Settings.System.putString(cr, key, v); break;
        }
        if (!ok) throw new Exception("Settings provider refused the write");
    }

    static Uri uri(int ns, String key) {
        switch (ns) {
            case GLOBAL: return Settings.Global.getUriFor(key);
            case SECURE: return Settings.Secure.getUriFor(key);
            default: return Settings.System.getUriFor(key);
        }
    }

    static String putLine(int ns, String key, String v) {
        return CLS[ns] + ".putString(\"" + key + "\", \"" + v + "\")";
    }

    static String shellLine(int ns, String key, String v) {
        return "settings put " + NS[ns] + " " + key + " " + v;
    }
}

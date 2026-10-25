package io.github.genmnz.warden;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Domain set stored as a sorted array of 64-bit FNV-1a hashes: 8 bytes per
 * domain, no strings kept, lookup is a binary search per name suffix.
 * A rule for "example.com" also matches every subdomain.
 */
final class Blocklist {
    final long[] block, allow;

    Blocklist(long[] block, long[] allow) { this.block = block; this.allow = allow; }

    static long hash(byte[] b, int off, int len) {
        long h = 0xcbf29ce484222325L;
        for (int i = off; i < off + len; i++) {
            int c = b[i] & 0xFF;
            if (c >= 'A' && c <= 'Z') c += 32;
            h = (h ^ c) * 0x100000001b3L;
        }
        return h;
    }

    static long hash(String s) {
        byte[] b = s.getBytes(StandardCharsets.ISO_8859_1);
        return hash(b, 0, b.length);
    }

    private static boolean anySuffix(long[] set, byte[] name, int len) {
        if (set.length == 0) return false;
        for (int i = 0; i < len; i++) {
            if (i == 0 || name[i - 1] == '.') {
                if (Arrays.binarySearch(set, hash(name, i, len - i)) >= 0) return true;
            }
        }
        return false;
    }

    /** name must be lowercase and dotted, as Packets.parseQuestion produces. */
    boolean blocked(byte[] name, int len) {
        return !anySuffix(allow, name, len) && anySuffix(block, name, len);
    }

    /** Growable long array used while compiling lists. */
    static final class Builder {
        long[] a = new long[1024];
        int n;

        void add(long h) {
            if (n == a.length) a = Arrays.copyOf(a, n * 2);
            a[n++] = h;
        }

        /** Parses hosts files, plain domain lists and simple adblock "||domain^" rules. Returns rules read. */
        int parse(InputStream in) throws IOException {
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            int count = 0;
            for (String line; (line = r.readLine()) != null; ) {
                int hashAt = line.indexOf('#');
                if (hashAt >= 0) line = line.substring(0, hashAt);
                line = line.trim();
                if (line.isEmpty() || line.charAt(0) == '!' || line.charAt(0) == '[') continue;
                if (line.startsWith("@@")) continue; // adblock exception rules: not supported
                for (String tok : line.split("\\s+")) {
                    String d = clean(tok);
                    if (d != null) { add(hash(d)); count++; }
                }
            }
            return count;
        }

        long[] sorted() {
            long[] s = Arrays.copyOf(a, n);
            Arrays.sort(s);
            int w = 0;
            for (int i = 0; i < s.length; i++) if (w == 0 || s[i] != s[w - 1]) s[w++] = s[i];
            return Arrays.copyOf(s, w);
        }
    }

    /** Turns one token into a bare lowercase domain, or null if it isn't one (IPs, URLs, wildcards). */
    static String clean(String t) {
        if (t.startsWith("||")) {
            t = t.substring(2);
            int caret = t.indexOf('^');
            if (caret >= 0) {
                if (caret != t.length() - 1) return null; // has modifiers like ^$third-party
                t = t.substring(0, caret);
            }
        }
        if (t.startsWith("*.")) t = t.substring(2);
        while (t.startsWith(".")) t = t.substring(1);
        while (t.endsWith(".")) t = t.substring(0, t.length() - 1);
        t = t.toLowerCase(java.util.Locale.ROOT);
        if (t.isEmpty() || t.length() > 253 || t.indexOf('.') < 0) return null;
        boolean digitsOnly = true;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_';
            if (!ok) return null;
            if (c != '.' && (c < '0' || c > '9')) digitsOnly = false;
        }
        if (digitsOnly) return null; // IPv4 address
        if (t.equals("localhost.localdomain") || t.endsWith(".local")) return null;
        return t;
    }

    static void save(File f, long[] set) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (DataOutputStream o = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(tmp), 65536))) {
            o.writeInt(set.length);
            for (long v : set) o.writeLong(v);
        }
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    static long[] load(File f) {
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(f), 65536))) {
            long[] s = new long[in.readInt()];
            for (int i = 0; i < s.length; i++) s[i] = in.readLong();
            return s;
        } catch (IOException e) {
            return new long[0];
        }
    }
}

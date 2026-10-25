package io.github.genmnz.warden;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

/** Desktop test for the pure-Java parts: run with tools/test.sh */
public final class PacketsTest {
    static int fails;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok) fails++;
    }

    static byte[] dnsQuery(String name, int qtype) {
        byte[] b = new byte[512];
        b[0] = 0x12; b[1] = 0x34; b[2] = 0x01; // RD
        Packets.put16(b, 4, 1);
        int p = 12;
        for (String l : name.split("\\.")) {
            b[p++] = (byte) l.length();
            for (char c : l.toCharArray()) b[p++] = (byte) c;
        }
        b[p++] = 0;
        Packets.put16(b, p, qtype); Packets.put16(b, p + 2, 1);
        return java.util.Arrays.copyOf(b, p + 4);
    }

    static byte[] wrap(boolean v4, byte[] dns, int dstPort) {
        int ip = v4 ? 20 : 40;
        byte[] p = new byte[ip + 8 + dns.length];
        if (v4) {
            p[0] = 0x45; Packets.put16(p, 2, p.length); p[8] = 64; p[9] = 17;
            p[12] = 10; p[13] = 111; p[14] = (byte) 222; p[15] = 2;
            p[16] = 10; p[17] = 111; p[18] = (byte) 222; p[19] = 1;
        } else {
            p[0] = 0x60; Packets.put16(p, 4, 8 + dns.length); p[6] = 17; p[7] = 64;
            p[8] = (byte) 0xfd; p[23] = 2; p[24] = 0x20; p[25] = 0x01; p[39] = (byte) 0x88;
        }
        Packets.put16(p, ip, 40000); Packets.put16(p, ip + 2, dstPort); Packets.put16(p, ip + 4, 8 + dns.length);
        System.arraycopy(dns, 0, p, ip + 8, dns.length);
        return p;
    }

    /** Ones' complement sum over a buffer region (0xFFFF/0 when checksum verifies). */
    static int csum(byte[] b, int off, int len, long acc) {
        for (int i = off; i < off + len; i += 2) acc += ((b[i] & 0xFF) << 8) | (i + 1 < off + len ? b[i + 1] & 0xFF : 0);
        while ((acc >> 16) != 0) acc = (acc & 0xFFFF) + (acc >> 16);
        return (int) acc;
    }

    static boolean l4ok(byte[] r, int len) {
        boolean v4 = Packets.isV4(r);
        int ip = v4 ? 20 : 40, l4len = len - ip;
        long acc = v4 ? csum(r, 12, 8, 0) : csum(r, 8, 32, 0);
        acc += Packets.proto(r) + l4len;
        return csum(r, ip, l4len, acc) == 0xFFFF;
    }

    public static void main(String[] a) throws Exception {
        Packets.Question q = new Packets.Question();
        for (boolean v4 : new boolean[]{true, false}) {
            String tag = v4 ? "[v4] " : "[v6] ";
            byte[] pkt = wrap(v4, dnsQuery("Ads.Example.COM", 1), 53);
            int l4 = Packets.l4Offset(pkt, pkt.length);
            check(l4 == (v4 ? 20 : 40), tag + "l4 offset");
            check(Packets.proto(pkt) == 17, tag + "proto udp");
            check(Packets.parseQuestion(pkt, l4 + 8, pkt.length - l4 - 8, q), tag + "parse question");
            check(new String(q.name, 0, q.nameLen, StandardCharsets.ISO_8859_1).equals("ads.example.com"), tag + "name lowercased");
            check(q.qtype == 1 && q.key().equals("ads.example.com/1/1"), tag + "qtype + key");
            byte[] dns = new byte[600], out = new byte[700];
            int dl = Packets.blockedAnswer(pkt, l4 + 8, q, dns);
            check(dl == q.end + 16, tag + "blocked A answer length");
            check(dns[0] == 0x12 && dns[1] == 0x34 && (dns[2] & 0x80) != 0 && Packets.u16(dns, 6) == 1, tag + "answer header");
            check(Packets.cacheTtl(dns, dl) == 60, tag + "ttl parse of our own answer");
            int n = Packets.udpReply(pkt, l4, dns, dl, out);
            check(n == l4 + 8 + dl, tag + "reply length");
            check(Packets.l4Offset(out, n) == l4, tag + "reply parses");
            check(Packets.u16(out, l4) == 53 && Packets.u16(out, l4 + 2) == 40000, tag + "ports swapped");
            check(l4ok(out, n), tag + "udp checksum valid");
            if (v4) {
                check(csum(out, 0, 20, 0) == 0xFFFF, tag + "ip header checksum valid");
                check(out[12] == 10 && out[15] == 1 && out[19] == 2, tag + "addresses swapped");
                check(Packets.u16(out, 2) == n, tag + "ip total length");
            } else {
                check(out[8] == 0x20 && out[39] == 2, tag + "addresses swapped");
                check(Packets.u16(out, 4) == n - 40, tag + "payload length");
            }
            // TCP SYN -> RST
            byte[] syn = new byte[(v4 ? 20 : 40) + 20];
            System.arraycopy(pkt, 0, syn, 0, v4 ? 20 : 40);
            if (v4) { syn[9] = 6; Packets.put16(syn, 2, syn.length); } else { syn[6] = 6; Packets.put16(syn, 4, 20); }
            int t = v4 ? 20 : 40;
            Packets.put16(syn, t, 50000); Packets.put16(syn, t + 2, 443);
            Packets.put32(syn, t + 4, 0xFFFFFFFFL); syn[t + 12] = 0x50; syn[t + 13] = 0x02;
            int rn = Packets.tcpReset(syn, syn.length, t, out);
            check(rn == t + 20 && out[t + 13] == 0x14, tag + "SYN gets RST|ACK");
            check(Packets.u16(out, t + 8) == 0 && Packets.u16(out, t + 10) == 0, tag + "ack = seq+1 wraps");
            check(l4ok(out, rn), tag + "tcp checksum valid");
            syn[t + 13] = 0x10;
            check(Packets.tcpReset(syn, syn.length, t, out) == 0, tag + "plain ACK ignored");
        }

        // AAAA and other types
        byte[] q6 = dnsQuery("x.test.org", 28);
        check(Packets.parseQuestion(q6, 0, q6.length, q) && Packets.blockedAnswer(q6, 0, q, new byte[600]) == q.end + 28, "AAAA answer");
        byte[] qh = dnsQuery("x.test.org", 65);
        check(Packets.parseQuestion(qh, 0, qh.length, q) && Packets.blockedAnswer(qh, 0, q, new byte[600]) == q.end, "HTTPS type gets NODATA");

        // response with compression + two answers, ttl 300 and 120
        byte[] r = new byte[200];
        byte[] base = dnsQuery("a.b", 1);
        System.arraycopy(base, 0, r, 0, base.length);
        r[2] = (byte) 0x81; r[3] = (byte) 0x80; Packets.put16(r, 6, 2);
        int p = base.length;
        for (int ttl : new int[]{300, 120}) {
            Packets.put16(r, p, 0xC00C); Packets.put16(r, p + 2, 1); Packets.put16(r, p + 4, 1);
            Packets.put32(r, p + 6, ttl); Packets.put16(r, p + 10, 4); p += 16;
        }
        check(Packets.cacheTtl(r, p) == 120, "min TTL across answers");
        r[2] |= 0x02;
        check(Packets.cacheTtl(r, p) == -1, "truncated not cached");
        check(Packets.cacheTtl(r, 20) == -1, "short response not cached");

        // malformed
        byte[] bad = dnsQuery("a.b", 1);
        bad[12] = (byte) 0xC0;
        check(!Packets.parseQuestion(bad, 0, bad.length, q), "pointer in question rejected");
        byte[] resp = dnsQuery("a.b", 1); resp[2] = (byte) 0x81;
        check(!Packets.parseQuestion(resp, 0, resp.length, q), "responses rejected");
        byte[] frag = wrap(true, dnsQuery("a.b", 1), 53); frag[6] = 0x20;
        check(Packets.l4Offset(frag, frag.length) == -1, "fragments skipped");

        // blocklist
        Blocklist.Builder bb = new Blocklist.Builder();
        String hosts = "# comment\n0.0.0.0 tracker.com\n127.0.0.1 a.ads.net b.ads.net # trailing\n::1 localhost\n"
                + "||adblock.io^\n||mod.io^$third-party\nplain.org\n*.wild.net\n1.2.3.4\n@@||ok.com^\n";
        int rules = bb.parse(new ByteArrayInputStream(hosts.getBytes(StandardCharsets.UTF_8)));
        check(rules == 6, "parsed rules = 6 (got " + rules + ")");
        Blocklist.Builder ab = new Blocklist.Builder();
        ab.add(Blocklist.hash("safe.tracker.com"));
        Blocklist bl = new Blocklist(bb.sorted(), ab.sorted());
        String[][] cases = {
                {"tracker.com", "1"}, {"x.y.tracker.com", "1"}, {"nottracker.com", "0"}, {"safe.tracker.com", "0"},
                {"deep.safe.tracker.com", "0"}, {"a.ads.net", "1"}, {"ads.net", "0"}, {"adblock.io", "1"},
                {"mod.io", "0"}, {"cdn.wild.net", "1"}, {"plain.org", "1"}, {"com", "0"}, {"localhost", "0"},
        };
        for (String[] c : cases) {
            byte[] nb = c[0].getBytes(StandardCharsets.ISO_8859_1);
            check(bl.blocked(nb, nb.length) == c[1].equals("1"), "blocked(" + c[0] + ") == " + c[1]);
        }
        java.io.File f = java.io.File.createTempFile("blocklist", ".bin");
        Blocklist.save(f, bl.block);
        check(java.util.Arrays.equals(Blocklist.load(f), bl.block), "save/load roundtrip");
        f.delete();

        // bundled lists parse
        for (String n : new String[]{"telemetry", "location", "samsung", "allow"}) {
            java.io.File lf = new java.io.File(a[0], n + ".txt");
            Blocklist.Builder lb = new Blocklist.Builder();
            int c = lb.parse(new java.io.FileInputStream(lf));
            int lines = 0;
            for (String line : java.nio.file.Files.readAllLines(lf.toPath())) if (!line.isBlank() && !line.startsWith("#")) lines++;
            check(c == lines && lb.sorted().length == c, n + ".txt: every line is a valid unique domain (" + c + ")");
        }
        System.out.println(fails == 0 ? "\nALL PASS" : "\n" + fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}

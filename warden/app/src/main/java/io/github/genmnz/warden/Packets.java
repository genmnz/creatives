package io.github.genmnz.warden;

/**
 * Raw IPv4/IPv6 + UDP/TCP + DNS helpers. Pure Java (no Android imports) so it
 * can be unit-tested on a desktop JVM. Works in place on caller-owned buffers:
 * nothing here allocates per packet.
 */
final class Packets {
    static final int UDP = 17, TCP = 6;
    static final int TYPE_A = 1, TYPE_AAAA = 28;

    private Packets() {}

    static int u16(byte[] b, int o) { return ((b[o] & 0xFF) << 8) | (b[o + 1] & 0xFF); }

    static void put16(byte[] b, int o, int v) { b[o] = (byte) (v >> 8); b[o + 1] = (byte) v; }

    static void put32(byte[] b, int o, long v) {
        b[o] = (byte) (v >> 24); b[o + 1] = (byte) (v >> 16); b[o + 2] = (byte) (v >> 8); b[o + 3] = (byte) v;
    }

    static boolean isV4(byte[] p) { return ((p[0] >> 4) & 0xF) == 4; }

    /** Offset of the transport header, or -1 for anything we don't handle (fragments, IPv6 ext headers). */
    static int l4Offset(byte[] p, int len) {
        if (len < 1) return -1;
        int v = (p[0] >> 4) & 0xF;
        if (v == 4) {
            if (len < 20) return -1;
            int ihl = (p[0] & 0xF) * 4;
            if (ihl < 20 || len < ihl) return -1;
            if ((p[6] & 0x3F) != 0 || p[7] != 0) return -1; // MF or fragment offset
            return ihl;
        }
        if (v == 6) return len >= 40 ? 40 : -1;
        return -1;
    }

    static int proto(byte[] p) { return isV4(p) ? p[9] & 0xFF : p[6] & 0xFF; }

    private static long sum(byte[] b, int off, int len, long acc) {
        int i = off, end = off + len;
        for (; i + 1 < end; i += 2) acc += ((b[i] & 0xFF) << 8) | (b[i + 1] & 0xFF);
        if (i < end) acc += (b[i] & 0xFF) << 8;
        return acc;
    }

    private static int fold(long acc) {
        while ((acc >> 16) != 0) acc = (acc & 0xFFFF) + (acc >> 16);
        return (int) (~acc & 0xFFFF);
    }

    /** TCP/UDP checksum over pseudo header + segment at out[ip..ip+l4len). */
    private static int l4Checksum(byte[] out, boolean v4, int ip, int l4len, int proto) {
        long acc = v4 ? sum(out, 12, 8, 0) : sum(out, 8, 32, 0);
        acc += proto + l4len;
        acc = sum(out, ip, l4len, acc);
        int c = fold(acc);
        return c == 0 && proto == UDP ? 0xFFFF : c;
    }

    /** Writes an IP header into out answering req (src/dst swapped). Returns header length. */
    private static int ipHeader(byte[] req, byte[] out, int proto, int l4len) {
        if (isV4(req)) {
            put16(out, 0, 0x4500); put16(out, 2, 20 + l4len); put32(out, 4, 0x4000);
            out[8] = 64; out[9] = (byte) proto; put16(out, 10, 0);
            System.arraycopy(req, 16, out, 12, 4);
            System.arraycopy(req, 12, out, 16, 4);
            put16(out, 10, fold(sum(out, 0, 20, 0)));
            return 20;
        }
        put32(out, 0, 0x60000000L); put16(out, 4, l4len); out[6] = (byte) proto; out[7] = 64;
        System.arraycopy(req, 24, out, 8, 16);
        System.arraycopy(req, 8, out, 24, 16);
        return 40;
    }

    /** Builds the full IP/UDP packet answering req (UDP at l4) with the given DNS payload. Returns length. */
    static int udpReply(byte[] req, int l4, byte[] dns, int dnsLen, byte[] out) {
        int ip = ipHeader(req, out, UDP, 8 + dnsLen);
        out[ip] = req[l4 + 2]; out[ip + 1] = req[l4 + 3];
        out[ip + 2] = req[l4]; out[ip + 3] = req[l4 + 1];
        put16(out, ip + 4, 8 + dnsLen); put16(out, ip + 6, 0);
        System.arraycopy(dns, 0, out, ip + 8, dnsLen);
        put16(out, ip + 6, l4Checksum(out, isV4(req), ip, 8 + dnsLen, UDP));
        return ip + 8 + dnsLen;
    }

    /**
     * Answers a TCP SYN with RST so DNS-over-HTTPS/TCP to a caught DNS address
     * fails at once (apps then fall back to plain DNS, which we filter). Returns 0 for non-SYN.
     */
    static int tcpReset(byte[] req, int len, int l4, byte[] out) {
        if (len < l4 + 20) return 0;
        int flags = req[l4 + 13] & 0xFF;
        if ((flags & 0x02) == 0 || (flags & 0x04) != 0) return 0;
        long seq = ((long) u16(req, l4 + 4) << 16) | u16(req, l4 + 6);
        int ip = ipHeader(req, out, TCP, 20);
        out[ip] = req[l4 + 2]; out[ip + 1] = req[l4 + 3];
        out[ip + 2] = req[l4]; out[ip + 3] = req[l4 + 1];
        put32(out, ip + 4, 0);
        put32(out, ip + 8, (seq + 1) & 0xFFFFFFFFL);
        out[ip + 12] = 0x50; out[ip + 13] = 0x14; // RST|ACK
        put16(out, ip + 14, 0); put16(out, ip + 16, 0); put16(out, ip + 18, 0);
        put16(out, ip + 16, l4Checksum(out, isV4(req), ip, 20, TCP));
        return ip + 20;
    }

    /** A parsed DNS question. Reused across packets. */
    static final class Question {
        final byte[] name = new byte[256];
        int nameLen, qtype, qclass;
        /** Length of header + question, relative to the DNS start. */
        int end;

        String key() {
            return new String(name, 0, nameLen, java.nio.charset.StandardCharsets.ISO_8859_1) + '/' + qtype + '/' + qclass;
        }
    }

    /** Parses a standard one-question query at p[off..off+len). Name is lowercased, dotted. */
    static boolean parseQuestion(byte[] p, int off, int len, Question q) {
        if (len < 17) return false;
        if ((p[off + 2] & 0xF8) != 0) return false; // must be a query, opcode 0
        if (u16(p, off + 4) != 1) return false;
        int pos = off + 12, lim = off + len, n = 0;
        while (true) {
            if (pos >= lim) return false;
            int l = p[pos++] & 0xFF;
            if (l == 0) break;
            if ((l & 0xC0) != 0 || pos + l > lim) return false;
            if (n > 0) q.name[n++] = '.';
            if (n + l > 253) return false;
            for (int i = 0; i < l; i++) {
                byte c = p[pos + i];
                q.name[n++] = (c >= 'A' && c <= 'Z') ? (byte) (c + 32) : c;
            }
            pos += l;
        }
        if (pos + 4 > lim) return false;
        q.nameLen = n;
        q.qtype = u16(p, pos);
        q.qclass = u16(p, pos + 2);
        q.end = pos + 4 - off;
        return true;
    }

    /** Builds a reply to the query at p[off..]: header+question copied, answer 0.0.0.0 / :: for A/AAAA. */
    static int blockedAnswer(byte[] p, int off, Question q, byte[] out) {
        System.arraycopy(p, off, out, 0, q.end);
        out[2] = (byte) (0x80 | (p[off + 2] & 0x01)); // QR, keep RD
        out[3] = (byte) 0x80; // RA, NOERROR
        int rdlen = q.qtype == TYPE_A ? 4 : q.qtype == TYPE_AAAA ? 16 : 0;
        put16(out, 6, rdlen > 0 ? 1 : 0); put16(out, 8, 0); put16(out, 10, 0);
        int n = q.end;
        if (rdlen > 0) {
            put16(out, n, 0xC00C); put16(out, n + 2, q.qtype); put16(out, n + 4, 1);
            put32(out, n + 6, 60); put16(out, n + 10, rdlen);
            n += 12;
            for (int i = 0; i < rdlen; i++) out[n++] = 0;
        }
        return n;
    }

    /** SERVFAIL for when no upstream DNS is known. */
    static int servfail(byte[] p, int off, Question q, byte[] out) {
        System.arraycopy(p, off, out, 0, q.end);
        out[2] = (byte) (0x80 | (p[off + 2] & 0x01));
        out[3] = (byte) 0x82;
        put16(out, 6, 0); put16(out, 8, 0); put16(out, 10, 0);
        return q.end;
    }

    private static int skipName(byte[] r, int pos, int len) {
        while (pos < len) {
            int l = r[pos] & 0xFF;
            if ((l & 0xC0) == 0xC0) return pos + 2;
            if (l == 0) return pos + 1;
            pos += l + 1;
        }
        return -1;
    }

    /**
     * Seconds this response may be cached: lowest answer TTL, 60 for NXDOMAIN/NODATA,
     * -1 if it must not be cached (error, truncated, unparsable).
     */
    static int cacheTtl(byte[] r, int len) {
        if (len < 12 || (r[2] & 0x02) != 0) return -1;
        int rcode = r[3] & 0x0F;
        if (rcode != 0 && rcode != 3) return -1;
        int qd = u16(r, 4), an = u16(r, 6);
        int pos = 12;
        for (int i = 0; i < qd; i++) {
            pos = skipName(r, pos, len);
            if (pos < 0 || (pos += 4) > len) return -1;
        }
        if (rcode == 3 || an == 0) return 60;
        long min = Long.MAX_VALUE;
        for (int i = 0; i < an; i++) {
            pos = skipName(r, pos, len);
            if (pos < 0 || pos + 10 > len) return -1;
            long ttl = ((long) u16(r, pos + 4) << 16) | u16(r, pos + 6);
            min = Math.min(min, ttl);
            pos += 10 + u16(r, pos + 8);
            if (pos > len) return -1;
        }
        return (int) Math.min(min, Integer.MAX_VALUE);
    }
}

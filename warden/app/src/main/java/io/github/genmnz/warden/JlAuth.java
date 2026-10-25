package io.github.genmnz.warden;

/**
 * JieLi RCSP authentication cipher (16-byte blocks, fixed key), used by the
 * handshake on GATT service AE00 before JieLi earbuds accept commands.
 *
 * Java port of qix_ble/auth.py from ElectronicCats/jieli-ble-badge-research
 * (MIT License, Copyright (c) 2026 Electronic Cats), itself a port of
 * hybridherbst/web-bluetooth-e87 jl_auth_v3.py (MIT). Verified against the
 * known-answer vectors from that project, see test/PacketsTest.java.
 */
final class JlAuth {
    private JlAuth() {}

    private static final int[] STATIC_KEY = hex("06775F87918DD423005DF1D8CF0C142B");
    private static final int[] MAGIC = hex("112233332211");
    private static final int MASK = 0x9999;

    private static final int[] SBOX = hex(
            "012de293be4515ae780387a4b838cf3f08670994eb26a86bbd18341bbbbf72f7"
            + "4035489c512f3b55e3c09fd8d3f38db1ffa73edc8677d7a611fbf4ba92916483"
            + "f133efda2cb5b22b88d199cb8c841d14819771ca5fa38b573c82c4525c1ce8a0"
            + "04b4854af61354b6df0c1a8edee039fc209b244ea9989eabf260d06ceafac7d9"
            + "00d41f6e43bcec5389fe7a5d49c932c2f99af86d16db599644e9cde646428f0a"
            + "c1ccb965b0d2c6ac1e4162292e0e7450025ac3257b8a2a5bf0060d476f709d7e"
            + "10ce1227d54c4fd679306836757de4ed806a9037a25e76aac57f3dafa5e51961"
            + "fd4d7cb70beead4b22f5e7732321c805e166ddb3586963560fa1319517073a28");
    private static final int[] ISBOX = hex(
            "8000b00960efb9fd10129fe469baadf8c038c2654f0694fc19de6a1b5d4ea882"
            + "70ede8ec72b315c3ffabb6474401ac25c9fa8e411a21cbd30d6efe2658da320f"
            + "20a99d8498059cbb228c63e7c5e173c6af245b876627f757f496b1b75c8bd554"
            + "79dfaaf63ea3f111caf5d1177b9383bcbd521eebaeccd63508c88ab4e2cdbfd9"
            + "d050593f4d62340a4888b5564c2e6b9ed23d3c0313fb9751754a917123be762a"
            + "5ff9d4550bdc37311674d777a7e607dba42f46f3614567e30ca23b1c8518041d"
            + "29a08fb25ad8a67eee8d534ba19ac10e7a49a52c81c4c7362b7f439533f26c68"
            + "6df00228cedd9bea5e997c1486cfe542b840782d3ae9641f92907d396fe08930");
    private static final int[] KS_TABLE = hex(
            "64ac285ac9b337c50a10b7a3bab197463d05dc666ef69af80d589567c6aaabec"
            + "a0689b96d4ebbf434936e96a89d8c38a946399bc7bbec122bb5c71d51f92575d"
            + "8f44411d51e64017fbfd193234b8612aca236fda39f7a2017fd631e7de8004dd"
            + "2c5982afa8e00fcda1123e30d11cd03a33722e4f9002130675ce87c2efb2ad7d"
            + "3815e1529f7a6c2f27c4e281a9cf8dc0d7dfff6076148c5e5509e408c74220fc"
            + "d25091d94c629ee8b9a6f91a00210bfa359c4e4b6948cb0ec8a45bea8407b418"
            + "f4ae6bdba7cc3f8b4a0c3c25e5544d4583ed11f0b05393f27426b59d6d7cf32d"
            + "f156247e471b86bd708e1e3b731603b6ac285ac9b337c50a10b7a3bab1974688");

    static int[] hex(String s) {
        s = s.replace(" ", "");
        int[] out = new int[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    /** Encrypts one 16-byte block the way JieLi firmware expects. */
    static byte[] encrypt(byte[] in) {
        if (in.length != 16) throw new IllegalArgumentException("16 bytes");
        int[] input = new int[16];
        for (int i = 0; i < 16; i++) input[i] = in[i] & 0xFF;
        int[] out = e1test(MAGIC, input, STATIC_KEY);
        byte[] r = new byte[16];
        for (int i = 0; i < 16; i++) r[i] = (byte) out[i];
        return r;
    }

    private static int[] keySchedule(int[] d) {
        int[] out = new int[272];
        System.arraycopy(d, 0, out, 0, 16);
        int[] buf = new int[17];
        int checksum = 0;
        for (int i = 0; i < 16; i++) { buf[i] = d[i]; checksum ^= d[i]; }
        buf[16] = checksum & 0xFF;
        for (int rnd = 0; rnd < 16; rnd++) {
            for (int i = 0; i < 17; i++) buf[i] = ((buf[i] << 3) | (buf[i] >> 5)) & 0xFF;
            int readPos = (rnd + 1) % 17;
            for (int j = 0; j < 16; j++) {
                out[16 + rnd * 16 + j] = (KS_TABLE[0xF + rnd * 16 - j] + buf[readPos]) & 0xFF;
                if (++readPos > 16) readPos = 0;
            }
        }
        return out;
    }

    /** The register-level butterfly from the firmware, kept in its original shape. */
    private static int[] fib(int[] s) {
        long[] r = new long[29];
        r[16] = s[0]; r[17] = s[1]; r[3] = s[2]; r[4] = s[3];
        r[5] = s[4]; r[6] = s[5]; r[7] = s[6]; r[19] = s[7];
        r[20] = s[8]; r[21] = s[9]; r[22] = s[10]; r[23] = s[11];
        r[24] = s[12]; r[25] = s[13]; r[26] = s[14]; r[27] = s[15];
        final long M = 0xFFFFFFFFL;
        // stage 1
        r[28] = (r[17] + r[16] * 2) & M; r[16] = (r[17] + r[16]) & M;
        r[17] = (r[4] + r[3] * 2) & M; r[3] = (r[4] + r[3]) & M;
        r[4] = (r[6] + r[5] * 2) & M; r[5] = (r[6] + r[5]) & M;
        r[6] = (r[19] + r[7] * 2) & M; r[7] = (r[19] + r[7]) & M;
        r[19] = (r[21] + r[20] * 2) & M; r[20] = (r[21] + r[20]) & M;
        r[21] = (r[23] + r[22] * 2) & M; r[22] = (r[23] + r[22]) & M;
        r[23] = (r[25] + r[24] * 2) & M; r[24] = (r[25] + r[24]) & M;
        r[25] = (r[27] + r[26] * 2) & M; r[26] = (r[27] + r[26]) & M;
        // stage 2
        r[27] = (r[22] + r[19] * 2) & M; r[19] = (r[22] + r[19]) & M;
        r[22] = (r[26] + r[23] * 2) & M; r[23] = (r[26] + r[23]) & M;
        r[26] = (r[16] + r[17] * 2) & M; r[16] = (r[17] + r[16]) & M;
        r[17] = (r[5] + r[6] * 2) & M; r[5] = (r[6] + r[5]) & M;
        r[6] = (r[20] + r[21] * 2) & M; r[20] = (r[21] + r[20]) & M;
        r[21] = (r[24] + r[25] * 2) & M; r[24] = (r[25] + r[24]) & M;
        r[25] = (r[7] + r[28] * 2) & M; r[7] = (r[7] + r[28]) & M;
        r[28] = (r[3] + r[4] * 2) & M; r[3] = (r[4] + r[3]) & M;
        // stage 3
        r[4] = (r[24] + r[6] * 2) & M; r[6] = (r[24] + r[6]) & M;
        r[24] = (r[3] + r[25] * 2) & M; r[3] = (r[25] + r[3]) & M;
        r[25] = (r[19] + r[22] * 2) & M; r[19] = (r[22] + r[19]) & M;
        r[22] = (r[16] + r[17] * 2) & M; r[16] = (r[17] + r[16]) & M;
        r[17] = (r[20] + r[21] * 2) & M; r[20] = (r[21] + r[20]) & M;
        r[21] = (r[7] + r[28] * 2) & M; r[7] = (r[7] + r[28]) & M;
        r[28] = (r[5] + r[27] * 2) & M; r[5] = (r[27] + r[5]) & M;
        r[27] = (r[23] + r[26] * 2) & M; r[23] = (r[23] + r[26]) & M;
        // stage 4
        r[26] = (r[7] + r[17] * 2) & M; r[17] = (r[17] + r[7]) & M;
        r[7] = (r[23] + r[28] * 2) & M; r[23] = (r[23] + r[28]) & M;
        r[28] = (r[6] + r[24] * 2) & M; r[6] = (r[6] + r[24]) & M;
        r[24] = (r[19] + r[22] * 2) & M; r[19] = (r[19] + r[22]) & M;
        r[22] = (r[20] + r[21] * 2) & M; r[20] = (r[20] + r[21]) & M;
        r[21] = (r[5] + r[27] * 2) & M; r[5] = (r[27] + r[5]) & M;
        r[27] = (r[16] + r[4] * 2) & M; r[16] = (r[4] + r[16]) & M;
        r[4] = (r[3] + r[25] * 2) & M; r[3] = (r[25] + r[3]) & M;
        int[] idx = {26, 17, 7, 23, 28, 6, 24, 19, 22, 20, 21, 5, 27, 16, 4, 3};
        int[] out = new int[16];
        for (int i = 0; i < 16; i++) out[i] = (int) (r[idx[i]] & 0xFF);
        return out;
    }

    /** phase 3: mask bit set → XOR, clear → ADD. phase 5: the opposite. */
    private static void condMix(int[] s, int[] k, int off, int phase) {
        for (int i = 0; i < 16; i++) {
            boolean bit = ((1 << i) & MASK) != 0;
            if ((phase == 3) == bit) s[i] ^= k[off + i];
            else s[i] = (k[off + i] + s[i]) & 0xFF;
        }
    }

    private static void sboxSub(int[] s) {
        for (int pos : new int[]{0, 3, 4, 7, 8, 11, 12, 15}) s[pos] = SBOX[s[pos]];
        for (int pos : new int[]{1, 2, 5, 6, 9, 10, 13, 14}) s[pos] = ISBOX[s[pos]];
    }

    private static int[] blockCipher(int[] state, int[] ek, int mode) {
        int[] s = state.clone(), initial = state.clone();
        condMix(s, ek, 0, 3);
        sboxSub(s);
        condMix(s, ek, 16, 5);
        for (int x9 = 1; x9 < 9; x9++) {
            s = fib(s);
            int off = x9 * 0x20;
            if (x9 == 8) {
                condMix(s, ek, 0x100, 3);
                break;
            }
            if (mode != 0 && x9 == 2) {
                for (int i = 0; i < 16; i++) {
                    if (((1 << i) & MASK) != 0) s[i] ^= initial[i];
                    else s[i] = (initial[i] + s[i]) & 0xFF;
                }
            }
            condMix(s, ek, off, 3);
            sboxSub(s);
            condMix(s, ek, off + 16, 5);
        }
        return s;
    }

    private static int[] e1test(int[] key6, int[] input, int[] seed) {
        int[] out = blockCipher(input.clone(), keySchedule(seed), 0);
        for (int i = 0; i < 16; i++) out[i] = (key6[i % 6] + (out[i] ^ input[i])) & 0xFF;
        int[] add = {-0x17, 0, -0x21, 0, -0x4D, 0, -0x6B, 0, 0, -0x1B, 0, -0x3F, 0, -0x59, 0, -0x7D};
        int[] xor = {0, 0xE5, 0, 0xC1, 0, 0xA7, 0, 0x83, 0xE9, 0, 0xDF, 0, 0xB3, 0, 0x95, 0};
        int[] obf = new int[16];
        for (int i = 0; i < 16; i++) obf[i] = xor[i] != 0 ? (seed[i] ^ xor[i]) & 0xFF : (seed[i] + add[i]) & 0xFF;
        return blockCipher(out, keySchedule(obf), 1);
    }
}

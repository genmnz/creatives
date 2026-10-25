package io.github.genmnz.warden;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Earbud recognition and protocols. Pure Java (no Android imports) so all of it
 * is unit-tested on a desktop JVM.
 *
 * Sources: Bluetooth SIG company identifiers, IEEE/Wireshark OUI list,
 * JieLi's own RCSP SDK (Jieli-Tech/Android-JL_Bluetooth), Redmi Buds JieLi notes
 * (Neisvestney/buds-sniffer),
 * Apple proximity-pairing layout as documented by the OpenPods project.
 */
final class Earbuds {
    private Earbuds() {}

    // ------------------------------------------------------------------ who made it

    /** Bluetooth SIG company IDs seen in earbud advertisements (verified against the SIG registry). */
    static String company(int id) {
        switch (id) {
            case 0x05D6: return "JieLi (Zhuhai Jieli) chip";
            case 0x0094: case 0x07E3: return "Airoha chip";
            case 0x02B0: return "Bestechnic (BES) chip";
            case 0x0642: return "Bluetrum chip";
            case 0x03E0: return "Actions chip";
            case 0x05F0: return "Beken chip";
            case 0x0A06: case 0x076E: return "WuQi chip";
            case 0x005D: return "Realtek chip";
            case 0x000A: case 0x001D: case 0x00D7: return "Qualcomm chip";
            case 0x0046: return "MediaTek chip";
            case 0x0211: return "Telink chip";
            case 0x000F: return "Broadcom chip";
            case 0x004C: return "Apple format (AirPods-style popup)";
            case 0x038F: return "Xiaomi format (Fast Connect)";
            case 0x027D: return "Huawei format";
            case 0x0075: return "Samsung format";
            case 0x00E0: case 0x018E: return "Google";
            case 0x0006: return "Microsoft Swift Pair";
            case 0x079A: return "OPPO format";
            case 0x08A4: return "realme format";
            case 0x072F: return "OnePlus format";
            case 0x0CC2: return "Anker / Soundcore format";
            case 0x012D: return "Sony";
            case 0x009E: return "Bose";
            default: return null;
        }
    }

    /** Chip makers that register the first half of their Bluetooth addresses (OUI). */
    private static final String[][] OUI = {
            {"0C:FC:83", "Airoha"}, {"00:E0:4C", "Realtek"}, {"FC:93:4E", "Realtek"},
            {"40:5A:DD", "Actions"}, {"D0:C0:BF", "Actions"}, {"FC:19:28", "Actions"}, {"F4:4E:FD", "Actions"},
            {"70:87:9E", "Beken"}, {"80:6D:DE", "Beken"}, {"C8:47:8C", "Beken"},
            {"2C:64:F6", "WuQi"}, {"30:6D:34", "WuQi"}, {"40:87:E5", "WuQi"}, {"48:55:5C", "WuQi"},
            {"6C:11:B3", "WuQi"}, {"D4:13:B3", "WuQi"}, {"D8:4D:B9", "WuQi"}, {"D8:A6:F0", "WuQi"},
            {"00:02:5B", "Qualcomm (CSR)"},
    };

    static String ouiVendor(String mac) {
        if (mac == null || mac.length() < 8) return null;
        String p = mac.substring(0, 8).toUpperCase(Locale.ROOT);
        for (String[] o : OUI) if (o[0].equals(p)) return o[1];
        return null;
    }

    /** Services (GATT or SDP) that identify the chip or its control protocol. */
    static String service(String uuid) {
        String u = uuid.toLowerCase(Locale.ROOT);
        if (u.startsWith("0000ae00-")) return "JieLi RCSP control";
        if (u.equals("5052494d-2dab-0341-6972-6f6861424c45")) return "Airoha RACE control";
        if (u.equals("00000000-0000-0000-0099-aabbccddeeff")) return "Airoha RACE (classic)";
        if (u.equals("00001107-d102-11e1-9b23-00025b00a5a5")) return "Qualcomm GAIA control";
        if (u.equals("dc405470-a351-4a59-97d8-2e2e3b207fbb")) return "Sony (Airoha-based) control";
        if (u.startsWith("49535343-fe7d-")) return "Microchip transparent UART";
        if (u.startsWith("0000af00-")) return "Xiaomi MMA control";
        if (u.startsWith("0000fd2d-")) return "Xiaomi Fast Connect";
        if (u.startsWith("0000fe2c-")) return "Google Fast Pair";
        if (u.startsWith("0000180f-")) return "Battery level";
        if (u.startsWith("0000180a-")) return "Device information";
        if (u.startsWith("0000184e-") || u.startsWith("0000184f-") || u.startsWith("00001850-")) return "LE Audio";
        if (u.startsWith("0000110b-")) return "Music (A2DP)";
        if (u.startsWith("0000111e-")) return "Calls (HFP)";
        if (u.startsWith("0000110e-")) return "Media buttons (AVRCP)";
        if (u.startsWith("00001101-")) return "Serial port (SPP)";
        return null;
    }

    /** True for the standard Bluetooth SIG 16-bit range (xxxx-0000-1000-8000-00805f9b34fb). */
    static boolean isSigUuid(String uuid) {
        String u = uuid.toLowerCase(Locale.ROOT);
        return u.startsWith("0000") && u.endsWith("-0000-1000-8000-00805f9b34fb");
    }

    /**
     * Classic (SDP) services: names what we know, and flags any unknown 128-bit UUID as a
     * vendor control channel. Such a channel is how most clone chips (Airoha, BES, Bluetrum,
     * Actions, Qualcomm) talk to their own apps, so it's a strong "controllable" clue even
     * when the vendor isn't in any list.
     */
    static String classicService(String uuid) {
        String known = service(uuid);
        if (known != null) return known;
        String u = uuid.toLowerCase(Locale.ROOT);
        if (isSigUuid(u)) {
            switch (u.substring(4, 8)) {
                case "1108": return "Headset (HSP)";
                case "110a": return "Audio source";
                case "110c": return "Remote control target";
                case "111f": return "Hands-free gateway";
                case "1200": return "Device ID (PnP)";
                case "1131": return "Headset audio gateway";
                default: return null;
            }
        }
        return "Vendor control channel (unknown maker)";
    }

    /** Bluetooth Class of Device → what the buds claim to be. That's what Samsung's icon is based on. */
    static String deviceClass(int cod) {
        int major = cod & 0x1F00;
        if (major == 0x1F00) return "uncategorised (no type) — why phones show a generic Bluetooth icon";
        if (major != 0x0400) {
            switch (major) {
                case 0x0000: return "miscellaneous";
                case 0x0100: return "computer";
                case 0x0200: return "phone";
                case 0x0500: return "input device";
                case 0x0700: return "wearable";
                default: return String.format(Locale.ROOT, "class 0x%04X", cod & 0x1FFC);
            }
        }
        switch (cod & 0x1FFC) {
            case 0x0404: return "wearable headset";
            case 0x0408: return "hands-free";
            case 0x0414: return "loudspeaker";
            case 0x0418: return "headphones";
            case 0x041C: return "portable audio";
            case 0x0420: return "car audio";
            default: return "audio/video device";
        }
    }

    static String deviceType(int t) {
        switch (t) {
            case 1: return "Classic only";
            case 2: return "LE only";
            case 3: return "Classic + LE";
            default: return "unknown";
        }
    }

    /** Samsung Galaxy Buds' own control service (real buds always offer it over Classic). */
    static final String SAMSUNG_BUDS_SPP = "2e73a4ad-332d-41fc-90e2-16bef06523f2";

    /**
     * Spots look-alikes: a big-brand name without that brand's own control service.
     * Returns a plain explanation, or null if nothing looks off.
     */
    static String lookalike(String name, List<String> uuids) {
        if (name == null) return null;
        String n = name.toLowerCase(Locale.ROOT);
        boolean samsungSvc = false;
        for (String u : uuids) if (u.equalsIgnoreCase(SAMSUNG_BUDS_SPP)) samsungSvc = true;
        if (n.contains("galaxy buds") && !samsungSvc)
            return "Named like Samsung Galaxy Buds, but it lacks Samsung's own control service: it's a look-alike. "
                    + "That's why Samsung Wearable doesn't recognise it.";
        if ((n.contains("airpods") || n.contains("air pods")) && !uuids.isEmpty())
            return "Named like AirPods, which phones other than iPhones can't control: most likely a look-alike.";
        return null;
    }

    /** Best single guess from everything seen. */
    static String chipVerdict(List<String> clues) {
        for (String c : clues) if (c.contains("JieLi")) return "JieLi";
        for (String c : clues) if (c.contains("Airoha") || c.contains("Sony (Airoha")) return "Airoha";
        for (String c : clues) if (c.contains("Bestechnic")) return "Bestechnic (BES)";
        for (String c : clues) if (c.contains("Bluetrum")) return "Bluetrum";
        for (String c : clues) if (c.contains("Qualcomm")) return "Qualcomm";
        for (String c : clues) if (c.contains("Realtek")) return "Realtek";
        for (String c : clues) if (c.contains("Actions")) return "Actions";
        for (String c : clues) if (c.contains("Beken")) return "Beken";
        for (String c : clues) if (c.contains("WuQi")) return "WuQi";
        return null;
    }

    // ------------------------------------------------------------------ battery

    /** Battery snapshot: -1 = unknown. Charging flags only meaningful when the level is known. */
    static final class Battery {
        int left = -1, right = -1, box = -1, single = -1;
        boolean leftCharging, rightCharging, boxCharging;
        String source = "", model = "";

        boolean any() { return left >= 0 || right >= 0 || box >= 0 || single >= 0; }

        @Override public String toString() {
            StringBuilder sb = new StringBuilder();
            if (single >= 0) sb.append(single).append('%');
            part(sb, "L", left, leftCharging);
            part(sb, "R", right, rightCharging);
            part(sb, "Case", box, boxCharging);
            return sb.length() == 0 ? "unknown" : sb.toString();
        }

        private static void part(StringBuilder sb, String k, int v, boolean ch) {
            if (v < 0) return;
            if (sb.length() > 0) sb.append("  ");
            sb.append(k).append(' ').append(v).append('%').append(ch ? " ⚡" : "");
        }
    }

    private static final String[][] APPLE_MODELS = {
            {"0220", "AirPods 1"}, {"0f20", "AirPods 2"}, {"1320", "AirPods 3"}, {"1920", "AirPods 4"},
            {"0e20", "AirPods Pro"}, {"1420", "AirPods Pro 2"}, {"2420", "AirPods Pro 2 (USB-C)"},
            {"2720", "AirPods Pro 3"}, {"0a20", "AirPods Max"}, {"0b20", "Powerbeats Pro"},
    };

    /**
     * Apple "proximity pairing" advertisement (company 0x004C, type 0x07), which many
     * clone earbuds copy to get the iPhone popup. md = data after the company ID.
     */
    static Battery apple(byte[] md) {
        if (md == null || md.length != 27 || md[0] != 0x07 || md[1] != 0x19) return null;
        Battery b = new Battery();
        String model = String.format(Locale.ROOT, "%02x%02x", md[3] & 0xFF, md[4] & 0xFF);
        b.model = "pretends to be unknown Apple model " + model;
        for (String[] m : APPLE_MODELS) if (m[0].equals(model)) b.model = "pretends to be " + m[1];
        int status = (md[5] >> 4) & 0xF;
        boolean flip = (status & 0x02) == 0;
        int hi = (md[6] >> 4) & 0xF, lo = md[6] & 0xF;
        int charge = (md[7] >> 4) & 0xF, box = md[7] & 0xF;
        b.left = applePct(flip ? hi : lo);
        b.right = applePct(flip ? lo : hi);
        b.box = applePct(box);
        b.leftCharging = (charge & (flip ? 0x02 : 0x01)) != 0;
        b.rightCharging = (charge & (flip ? 0x01 : 0x02)) != 0;
        b.boxCharging = (charge & 0x04) != 0;
        b.source = "Apple-style advertisement";
        return b;
    }

    private static int applePct(int v) { return v <= 10 ? v * 10 : -1; }

    /** Xiaomi manufacturer data (company 0x038F), used by Redmi Buds and their JieLi clones. */
    static Battery xiaomi(byte[] p) {
        if (p == null || p.length < 24 || (p[0] != 0x16 && p[0] != 0x17) || p[1] != 0x01) return null;
        Battery b = new Battery();
        b.left = pct7(p[5]); b.leftCharging = (p[5] & 0x80) != 0;
        b.right = pct7(p[6]); b.rightCharging = (p[6] & 0x80) != 0;
        b.box = pct7(p[7]); b.boxCharging = (p[7] & 0x80) != 0;
        b.source = "Xiaomi-style advertisement";
        return b;
    }

    /**
     * The buds' Classic address hidden in a Xiaomi-style advertisement (bytes 11..16,
     * stored permuted). Lets Melad tie an LE advertiser to the paired buds you're listening on.
     */
    static String xiaomiEdrMac(byte[] p) {
        if (p == null || p.length < 17 || (p[0] != 0x16 && p[0] != 0x17) || p[1] != 0x01) return null;
        int[] order = {12, 11, 13, 16, 15, 14};
        StringBuilder sb = new StringBuilder();
        for (int i : order) sb.append(sb.length() > 0 ? ":" : "").append(String.format(Locale.ROOT, "%02X", p[i] & 0xFF));
        return sb.toString();
    }

    /** Xiaomi Fast Connect service data (UUID 0xFD2D). Right comes before left here. */
    static Battery xiaomiFd2d(byte[] sd) {
        if (sd == null || sd.length <= 14) return null;
        Battery b = new Battery();
        b.right = pct7(sd[12]); b.rightCharging = (sd[12] & 0x80) != 0;
        b.left = pct7(sd[13]); b.leftCharging = (sd[13] & 0x80) != 0;
        b.box = pct7(sd[14]); b.boxCharging = (sd[14] & 0x80) != 0;
        b.source = "Xiaomi Fast Connect";
        return b;
    }

    /** Low 7 bits = %, 0 = no data (bud in a closed case). */
    private static int pct7(byte v) {
        int p = v & 0x7F;
        return p == 0 || p > 100 ? -1 : p;
    }

    // ------------------------------------------------------------------ JieLi RCSP

    static final int RCSP_GET_SYS_INFO = 0x07, RCSP_SET_SYS_INFO = 0x08;
    static final int RCSP_SET_ADV = 0xC0, RCSP_GET_ADV = 0xC1, RCSP_ADV_PUSH = 0xC2, RCSP_DEV_REQUEST = 0xC4;
    /** ADV attribute types from JieLi's SDK (AttrAndFunCode.ADV_TYPE_*). */
    static final int ADV_BATTERY = 0, ADV_NAME = 1, ADV_KEYS = 2, ADV_MIC = 4, ADV_WORK_MODE = 5,
            ADV_PRODUCT = 6, ADV_IN_EAR = 8, ADV_ANC_LIST = 10;
    static final int SYS_ATTR_VOICE_MODE = 13;
    static final byte[] AUTH_PASS = {0x02, 'p', 'a', 's', 's'};

    /** FE DC BA | flags | op | len (BE) | sn | params | EF. flags 0xC0 = command expecting a reply. */
    static byte[] rcspCommand(int op, int sn, byte[] params) {
        return rcsp(0xC0, op, concat(new byte[]{(byte) sn}, params));
    }

    /** Reply to a command the earbuds sent us: status 0 + their sn. */
    static byte[] rcspReply(int op, int sn) {
        return rcsp(0x00, op, new byte[]{0, (byte) sn});
    }

    private static byte[] rcsp(int flags, int op, byte[] body) {
        byte[] f = new byte[8 + body.length];
        f[0] = (byte) 0xFE; f[1] = (byte) 0xDC; f[2] = (byte) 0xBA;
        f[3] = (byte) flags; f[4] = (byte) op;
        f[5] = (byte) (body.length >> 8); f[6] = (byte) body.length;
        System.arraycopy(body, 0, f, 7, body.length);
        f[f.length - 1] = (byte) 0xEF;
        return f;
    }

    /** [len][type][value...] with len = value length + 1. */
    static byte[] ltv(int type, byte[] value) {
        byte[] r = new byte[2 + value.length];
        r[0] = (byte) (value.length + 1);
        r[1] = (byte) type;
        System.arraycopy(value, 0, r, 2, value.length);
        return r;
    }

    static byte[] getAdvInfo(int sn) { return rcspCommand(RCSP_GET_ADV, sn, be32(0xFFFFFFFF)); }

    static byte[] setAdv(int sn, int type, byte[] value) { return rcspCommand(RCSP_SET_ADV, sn, ltv(type, value)); }

    static byte[] getVoiceMode(int sn) {
        return rcspCommand(RCSP_GET_SYS_INFO, sn, concat(new byte[]{(byte) 0xFF}, be32(1 << SYS_ATTR_VOICE_MODE)));
    }

    /** current = the 9-byte voice-mode record read from the earbuds; only its mode byte changes. */
    static byte[] setVoiceMode(int sn, byte[] current, int mode) {
        byte[] v = current.clone();
        v[0] = (byte) mode;
        return rcspCommand(RCSP_SET_SYS_INFO, sn, concat(new byte[]{(byte) 0xFF}, ltv(SYS_ATTR_VOICE_MODE, v)));
    }

    /** One decoded RCSP frame. For replies, status and sn are split out of the payload. */
    static final class Frame {
        int flags, op, status = -1, sn = -1;
        byte[] params = new byte[0];

        boolean isCommand() { return (flags & 0x80) != 0; }

        boolean wantsReply() { return (flags & 0x40) != 0; }
    }

    /** Reassembles frames from GATT notifications (one frame can span several). */
    static final class RcspReader {
        private byte[] buf = new byte[0];

        List<Frame> feed(byte[] chunk) {
            buf = concat(buf, chunk);
            List<Frame> out = new ArrayList<>();
            while (true) {
                int head = -1;
                for (int i = 0; i + 2 < buf.length; i++) {
                    if (buf[i] == (byte) 0xFE && buf[i + 1] == (byte) 0xDC && buf[i + 2] == (byte) 0xBA) { head = i; break; }
                }
                if (head < 0) { buf = buf.length > 2 ? java.util.Arrays.copyOfRange(buf, buf.length - 2, buf.length) : buf; return out; }
                if (head > 0) buf = java.util.Arrays.copyOfRange(buf, head, buf.length);
                if (buf.length < 8) return out;
                int len = ((buf[5] & 0xFF) << 8) | (buf[6] & 0xFF);
                if (buf.length < 8 + len) return out;
                if (buf[7 + len] != (byte) 0xEF) { buf = java.util.Arrays.copyOfRange(buf, 1, buf.length); continue; }
                Frame f = new Frame();
                f.flags = buf[3] & 0xFF;
                f.op = buf[4] & 0xFF;
                byte[] body = java.util.Arrays.copyOfRange(buf, 7, 7 + len);
                if (f.isCommand()) {
                    if (body.length > 0 && f.wantsReply()) { f.sn = body[0] & 0xFF; body = java.util.Arrays.copyOfRange(body, 1, body.length); }
                } else if (body.length >= 2) {
                    f.status = body[0] & 0xFF;
                    f.sn = body[1] & 0xFF;
                    body = java.util.Arrays.copyOfRange(body, 2, body.length);
                }
                f.params = body;
                out.add(f);
                buf = java.util.Arrays.copyOfRange(buf, 8 + len, buf.length);
            }
        }
    }

    /** Battery from the 0xC2 push JieLi earbuds send every ~0.5 s after authentication. */
    static Battery jieliPush(byte[] p) {
        if (p != null && p.length >= 18 && !(p[0] == 0x05 && p[1] == (byte) 0xD6) && p[1] == 0x05 && p[2] == (byte) 0xD6) {
            p = java.util.Arrays.copyOfRange(p, 1, p.length); // firmware that puts a sequence byte first
        }
        if (p == null || p.length < 17) return null;
        Battery b = new Battery();
        b.left = pct7(p[14]); b.leftCharging = (p[14] & 0x80) != 0;
        b.right = pct7(p[15]); b.rightCharging = (p[15] & 0x80) != 0;
        b.box = pct7(p[16]); b.boxCharging = (p[16] & 0x80) != 0;
        b.source = "JieLi live";
        return b;
    }

    /** Settings read from the earbuds (GetADVInfo reply). -1 = not supported by this firmware. */
    static final class JieliInfo {
        String name;
        int workMode = -1, micChannel = -1, inEar = -1, ancModes = -1, vid = -1, pid = -1;
        Battery battery;
    }

    static JieliInfo parseAdvInfo(byte[] p) {
        JieliInfo info = new JieliInfo();
        int i = 0;
        while (i + 1 < p.length) {
            int len = p[i] & 0xFF;
            if (len < 1 || i + 1 + len > p.length) break;
            int type = p[i + 1] & 0xFF;
            byte[] v = java.util.Arrays.copyOfRange(p, i + 2, i + 1 + len);
            switch (type) {
                case ADV_BATTERY:
                    if (v.length >= 3) {
                        Battery b = new Battery();
                        b.left = pct7(v[0]); b.leftCharging = (v[0] & 0x80) != 0;
                        b.right = pct7(v[1]); b.rightCharging = (v[1] & 0x80) != 0;
                        b.box = pct7(v[2]); b.boxCharging = (v[2] & 0x80) != 0;
                        b.source = "JieLi";
                        info.battery = b;
                    }
                    break;
                case ADV_NAME: info.name = new String(v, StandardCharsets.UTF_8).trim(); break;
                case ADV_MIC: if (v.length > 0) info.micChannel = v[0] & 0xFF; break;
                case ADV_WORK_MODE: if (v.length > 0) info.workMode = v[0] & 0xFF; break;
                case ADV_IN_EAR: if (v.length > 0) info.inEar = v[0] & 0xFF; break;
                case ADV_ANC_LIST: if (v.length >= 4) info.ancModes = (int) be32read(v, 0); break;
                case ADV_PRODUCT:
                    if (v.length >= 6) { info.vid = u16(v, 0); info.pid = u16(v, 4); }
                    break;
                default: break;
            }
            i += 1 + len;
        }
        return info;
    }

    /** Voice-mode record (9 bytes: mode + gains) inside a GetSysInfo reply: [function][LTV...]. */
    static byte[] voiceModeRecord(byte[] p) {
        int i = 1;
        while (i + 1 < p.length) {
            int len = p[i] & 0xFF;
            if (len < 1 || i + 1 + len > p.length) return null;
            if ((p[i + 1] & 0xFF) == SYS_ATTR_VOICE_MODE && len - 1 >= 1) return java.util.Arrays.copyOfRange(p, i + 2, i + 1 + len);
            i += 1 + len;
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers

    static byte[] concat(byte[] a, byte[] b) {
        byte[] r = java.util.Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    static byte[] be32(int v) { return new byte[]{(byte) (v >> 24), (byte) (v >> 16), (byte) (v >> 8), (byte) v}; }

    private static long be32read(byte[] b, int o) {
        return ((long) (b[o] & 0xFF) << 24) | ((b[o + 1] & 0xFF) << 16) | ((b[o + 2] & 0xFF) << 8) | (b[o + 3] & 0xFF);
    }

    private static int u16(byte[] b, int o) { return ((b[o] & 0xFF) << 8) | (b[o + 1] & 0xFF); }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02X ", x & 0xFF));
        return sb.toString().trim();
    }

    static byte[] unhex(String s) {
        StringBuilder c = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) c.append(ch);
        }
        if (c.length() % 2 != 0) c.setLength(c.length() - 1);
        byte[] out = new byte[c.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(c.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    // ------------------------------------------------------------------ universal fallback (standard GATT)

    /** Standard Bluetooth Battery Service (0x180F / char 0x2A19): a single 0-100 byte. Works on many buds. */
    static Battery standardBattery(byte[] v) {
        if (v == null || v.length < 1) return null;
        int p = v[0] & 0xFF;
        if (p > 100) return null;
        Battery b = new Battery();
        b.single = p;
        b.source = "Standard Bluetooth battery";
        return b;
    }

    // ------------------------------------------------------------------ teachable custom rule

    /**
     * A rule the user teaches Melad for earbuds no list knows: it says which bytes of a
     * characteristic's value hold the battery levels. This is how Melad still gives
     * something useful for an unrecognised chip — you point at the byte, it reads it forever.
     */
    static final class CustomRule {
        String svc = "", chr = "";      // the notify/read characteristic the bytes come from
        int left = -1, right = -1, box = -1, single = -1; // byte offsets into the value, -1 = not used
        int mask = 0x7F;                // AND mask applied to each byte
        boolean highBitCharge = true;   // bit 0x80 = charging flag

        boolean usable() { return left >= 0 || right >= 0 || box >= 0 || single >= 0; }

        private int at(byte[] v, int off) {
            if (off < 0 || off >= v.length) return -1;
            int p = v[off] & mask;
            return p > 100 ? -1 : p;
        }

        private boolean charge(byte[] v, int off) {
            return highBitCharge && off >= 0 && off < v.length && (v[off] & 0x80) != 0;
        }

        Battery apply(byte[] v) {
            if (v == null) return null;
            Battery b = new Battery();
            b.left = at(v, left); b.leftCharging = charge(v, left);
            b.right = at(v, right); b.rightCharging = charge(v, right);
            b.box = at(v, box); b.boxCharging = charge(v, box);
            b.single = at(v, single);
            b.source = "Your custom rule";
            return b.any() ? b : null;
        }

        String serialize() {
            return String.join("|", svc, chr, Integer.toString(left), Integer.toString(right),
                    Integer.toString(box), Integer.toString(single), Integer.toString(mask), highBitCharge ? "1" : "0");
        }

        static CustomRule parse(String s) {
            if (s == null || s.isEmpty()) return null;
            String[] p = s.split("\\|", -1);
            if (p.length < 8) return null;
            try {
                CustomRule r = new CustomRule();
                r.svc = p[0]; r.chr = p[1];
                r.left = Integer.parseInt(p[2]); r.right = Integer.parseInt(p[3]);
                r.box = Integer.parseInt(p[4]); r.single = Integer.parseInt(p[5]);
                r.mask = Integer.parseInt(p[6]); r.highBitCharge = p[7].equals("1");
                return r;
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------ device history record

    private static final char SEP = '\u001f';

    /** One remembered device: nickname, what we learned about it, and a taught rule if any. */
    static final class BudRecord {
        String mac = "", name = "", chip = "", model = "", firmware = "", lastBattery = "";
        long lastSeen, connectedMs;
        CustomRule rule;

        static String clean(String s) {
            if (s == null) return "";
            StringBuilder b = new StringBuilder(s.length());
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                b.append(c < 0x20 ? ' ' : c);
            }
            return b.toString();
        }

        String serialize() {
            return String.join(String.valueOf(SEP), "1", clean(mac), clean(name), clean(chip), clean(model),
                    clean(firmware), clean(lastBattery), Long.toString(lastSeen), Long.toString(connectedMs),
                    rule == null ? "" : rule.serialize());
        }

        static BudRecord parse(String line) {
            if (line == null) return null;
            String[] p = line.split(String.valueOf(SEP), -1);
            if (p.length < 10 || !p[0].equals("1")) return null;
            try {
                BudRecord r = new BudRecord();
                r.mac = p[1]; r.name = p[2]; r.chip = p[3]; r.model = p[4]; r.firmware = p[5];
                r.lastBattery = p[6]; r.lastSeen = Long.parseLong(p[7]); r.connectedMs = Long.parseLong(p[8]);
                r.rule = CustomRule.parse(p[9]);
                return r;
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    /** Human "connected for 3 h 20 m" from milliseconds. */
    static String uptime(long ms) {
        long s = ms / 1000, h = s / 3600, m = (s % 3600) / 60;
        if (h > 0) return h + " h " + m + " m";
        if (m > 0) return m + " m " + (s % 60) + " s";
        return s + " s";
    }
}

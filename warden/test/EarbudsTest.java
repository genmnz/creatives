package io.github.genmnz.warden;

import java.util.Arrays;
import java.util.List;

/** Desktop tests for the earbud protocols: run with tools/test.sh */
public final class EarbudsTest {
    static int fails;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok) fails++;
    }

    static byte[] h(String s) {
        s = s.replace(" ", "");
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    public static void main(String[] a) {
        // JieLi cipher: known-answer vectors from ElectronicCats/jieli-ble-badge-research (two from real hardware)
        String[][] kat = {
                {"b6e080ecaff322916d88fad5aa34c2ac", "1d8897ac4604d332e8175e81bb292524"},
                {"a53057d376fc0476e5dc68273b5e791e", "b3242d82e1df6c545895ecae13b44fea"},
                {"384ac9d8e481e5caaeb8cead20ee8f9e", "fe1b5b643a790fdcf585e354dd377b0f"},
        };
        for (String[] k : kat) check(Arrays.equals(JlAuth.encrypt(h(k[0])), h(k[1])), "JieLi auth KAT " + k[0].substring(0, 8));

        // RCSP framing: GetTargetInfo captured from a real device (fe dc ba c0 03 00 06 74 ff ff ff ff 00 ef)
        check(Arrays.equals(Earbuds.rcspCommand(0x03, 0x74, h("ffffffff00")), h("fedcbac0030006 74ffffffff00ef")), "RCSP frame matches capture");
        check(Arrays.equals(Earbuds.getAdvInfo(1), h("fedcbac0c10005 01ffffffff ef")), "GetADVInfo frame");
        check(Arrays.equals(Earbuds.setAdv(2, Earbuds.ADV_WORK_MODE, new byte[]{2}), h("fedcbac0c00004 02 020502 ef")), "game mode on frame");
        check(Arrays.equals(Earbuds.getVoiceMode(3), h("fedcbac0070006 03 ff00002000 ef")), "get ANC mode frame");
        byte[] rec = h("01 0005 0005 0003 0003");
        check(Arrays.equals(Earbuds.setVoiceMode(4, rec, 2), h("fedcbac008000d 04 ff 0a0d 02000500050003 0003 ef")), "set ANC keeps gains");
        check(Arrays.equals(Earbuds.rcspReply(0xC4, 9), h("fedcba00c40002 0009 ef")), "reply to device request");

        // reader: the 0xC2 battery push from the Redmi Buds notes, split over two notifications, plus a reply
        Earbuds.RcspReader rd = new Earbuds.RcspReader();
        byte[] push = h("fedcba80c20012 05d6 0002 0033 22 7cc95e2581d8 02 e46400 7c ef");
        List<Earbuds.Frame> f1 = rd.feed(Arrays.copyOfRange(push, 0, 9));
        List<Earbuds.Frame> f2 = rd.feed(Earbuds.concat(Arrays.copyOfRange(push, 9, push.length), h("fedcba00c10007 00 01 03 00 e40000 ef")));
        check(f1.isEmpty() && f2.size() == 2, "reassembles split frames (" + f2.size() + ")");
        Earbuds.Battery pb = Earbuds.jieliPush(f2.get(0).params);
        check(pb != null && pb.left == 100 && pb.leftCharging && pb.right == 100 && !pb.rightCharging && pb.box == -1, "JieLi push battery: " + pb);
        check(f2.get(1).op == 0xC1 && f2.get(1).status == 0 && f2.get(1).sn == 1, "reply status/sn split");
        Earbuds.JieliInfo info = Earbuds.parseAdvInfo(h("04 00 e45a32  06 01 4275647331  02 05 02  02 04 01  02 08 01  05 0a 00000007  07 06 05d6 0002 0033"));
        check(info.battery != null && info.battery.left == 100 && info.battery.right == 90 && info.battery.box == 50, "ADV info battery " + info.battery);
        check("Buds1".equals(info.name) && info.workMode == 2 && info.micChannel == 1 && info.inEar == 1, "ADV info settings");
        check(info.ancModes == 7 && info.vid == 0x05D6 && info.pid == 0x0033, "ADV info ANC list + ids");
        check(Arrays.equals(Earbuds.voiceModeRecord(h("ff 0a0d 01000500050003 0003")), h("01000500050003 0003")), "voice mode record");
        check(Earbuds.parseAdvInfo(h("09 01 41")).name == null, "truncated LTV ignored");

        // Apple-style advertisement (typical clone: model 0x0F20, L 80%, R 70%, case 50%, case charging)
        byte[] apple = new byte[27];
        apple[0] = 0x07; apple[1] = 0x19; apple[3] = 0x0F; apple[4] = 0x20;
        apple[5] = 0x22; apple[6] = 0x78; apple[7] = 0x45;
        Earbuds.Battery ab = Earbuds.apple(apple);
        check(ab != null && ab.left == 80 && ab.right == 70 && ab.box == 50 && ab.boxCharging && !ab.leftCharging, "Apple-style battery: " + ab);
        check(ab.model.contains("AirPods 2"), "Apple model: " + ab.model);
        apple[5] = 0x00; // flipped orientation
        Earbuds.Battery af = Earbuds.apple(apple);
        check(af.left == 70 && af.right == 80, "Apple flipped L/R");
        apple[6] = (byte) 0xF7;
        check(Earbuds.apple(apple).left == -1 && Earbuds.apple(apple).right == 70, "Apple 15 = disconnected");
        check(Earbuds.apple(new byte[10]) == null, "non-Apple data rejected");

        // Xiaomi 0x038F example from the Redmi Buds notes (all 0 in that sample) and a synthetic one
        byte[] xi = h("16 01 15 0D 4E E4 C6 2C 4B 0A 5F C9 7C 5E D8 81 25 00 C9 7C 5E D8 81 25");
        Earbuds.Battery xb = Earbuds.xiaomi(xi);
        check(xb != null && xb.left == 100 && xb.leftCharging && xb.right == 70 && xb.rightCharging && xb.box == 44, "Xiaomi battery: " + xb);

        // recognition
        check("Airoha".equals(Earbuds.ouiVendor("0c:fc:83:12:34:56")), "OUI lookup");
        check(Earbuds.company(0x05D6).startsWith("JieLi") && Earbuds.company(0x02B0).contains("BES"), "company IDs");
        check("JieLi RCSP control".equals(Earbuds.service("0000AE00-0000-1000-8000-00805F9B34FB")), "service lookup");
        check("Airoha".equals(Earbuds.chipVerdict(Arrays.asList("Battery level", "Airoha RACE control"))), "verdict");

        System.out.println(fails == 0 ? "\nALL PASS" : "\n" + fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}

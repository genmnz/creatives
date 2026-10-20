// ------------------------------------------------- Bluetooth detective -----
// Read-only report of what Windows knows about each paired Bluetooth device:
// chip/vendor ID, the profiles it offers (music, calls, remote control,
// vendor control channels), BLE services and battery. Nothing is written to
// the devices. Used to find out what an unbranded earbud is built on.
#include <setupapi.h>
#include <cfgmgr32.h>
#include <map>
#include <set>

struct BtReport {
    std::string mac, name;
    bool present = false, le = false;
    std::string vidSource, vid, pid;
    std::set<std::string> services;
    int battery = -1;
};

// Bluetooth SIG company identifiers of common audio chip makers and brands
// (from the official assigned-numbers list).
static const char* BtCompany(unsigned id) {
    switch (id) {
        case 0x004C: return "Apple (clones often copy Apple's ID)";
        case 0x000A: return "Qualcomm (CSR)";
        case 0x001D: case 0x00D7: return "Qualcomm";
        case 0x005D: return "Realtek";
        case 0x0094: case 0x07E3: return "Airoha (MediaTek group)";
        case 0x05D6: return "Zhuhai JieLi";
        case 0x0642: return "Bluetrum";
        case 0x03E0: return "Actions";
        case 0x02B0: return "Bestechnic (BES)";
        case 0x05F0: return "Beken";
        case 0x0211: return "Telink";
        case 0x0A06: case 0x076E: return "WuQi";
        case 0x04F7: return "Goodix";
        case 0x0046: return "MediaTek";
        case 0x000F: return "Broadcom";
        case 0x0059: return "Nordic Semiconductor";
        case 0x0075: return "Samsung";
        case 0x012D: return "Sony";
        case 0x009E: return "Bose";
        case 0x0057: case 0x075A: return "Harman/JBL";
        case 0x0494: return "Sennheiser";
        case 0x038F: return "Xiaomi";
        case 0x027D: return "Huawei";
        case 0x0CC2: return "Anker";
        case 0x079A: return "OPPO";
        case 0x072F: return "OnePlus";
        case 0x08A4: return "Realme";
        case 0x0837: return "vivo";
    }
    return nullptr;
}

static std::string BtServiceName(const std::string& uuid) {
    // 0000xxxx-0000-1000-8000-00805f9b34fb = standard 16-bit service
    std::string u = Lower(uuid);
    if (u.size() == 36 && u.compare(8, 28, "-0000-1000-8000-00805f9b34fb") == 0 && u.compare(0, 4, "0000") == 0) {
        std::string s = u.substr(4, 4);
        static const std::map<std::string, const char*> names = {
            {"110b", "music (A2DP)"}, {"110a", "audio source"}, {"110c", "remote control (AVRCP)"},
            {"110e", "remote control (AVRCP)"}, {"111e", "calls (Hands-Free)"}, {"1108", "calls (Headset)"},
            {"1101", "serial port (SPP - often the vendor's app/control channel)"}, {"1200", "device ID (PnP)"},
            {"180f", "battery (BLE)"}, {"180a", "device information (BLE)"}, {"1812", "keyboard/HID (BLE)"},
            {"184e", "LE Audio stream control"}, {"1850", "LE Audio capabilities"}, {"1853", "LE Audio common audio"},
            {"184f", "LE Audio broadcast"}, {"1844", "volume control (BLE)"}, {"fe2c", "Google Fast Pair"},
            {"fd5a", "Samsung"}, {"febe", "Bose"}, {"fe03", "Amazon"}, {"fdf0", "Google"}, {"1800", "generic access"},
            {"1801", "generic attribute"}};
        auto it = names.find(s);
        return it != names.end() ? it->second : "service 0x" + s;
    }
    return "vendor service " + u;  // custom 128-bit UUID: usually the maker's control protocol
}

// Last run of exactly 12 hex digits in an instance ID = the Bluetooth address.
static std::string MacFrom(const std::string& id) {
    std::string mac;
    for (size_t i = 0; i + 12 <= id.size(); i++) {
        size_t j = i;
        while (j < id.size() && isxdigit((unsigned char)id[j])) j++;
        if (j - i == 12 && (i == 0 || !isxdigit((unsigned char)id[i - 1]))) mac = id.substr(i, 12);
        if (j > i) i = j;
    }
    return Lower(mac);
}

static std::string Between(const std::string& s, const char* a, const char* b) {
    size_t p = s.find(a);
    if (p == std::string::npos) return std::string();
    p += strlen(a);
    size_t e = s.find(b, p);
    return s.substr(p, e == std::string::npos ? std::string::npos : e - p);
}

static std::vector<BtReport> BluetoothReport() {
    std::map<std::string, BtReport> devs;
    static const DEVPROPKEY kBattery = {{0x104EA319, 0x6EE2, 0x4701, {0xBD, 0x47, 0x8D, 0xDB, 0xF4, 0x25, 0xBB, 0xE5}}, 2};
    for (const wchar_t* en : {L"BTHENUM", L"BTHLE", L"BTHLEDEVICE"}) {
        for (int pass = 0; pass < 2; pass++) {  // pass 0: everything paired, pass 1: currently present
            HDEVINFO set = SetupDiGetClassDevsW(nullptr, en, nullptr, DIGCF_ALLCLASSES | (pass ? DIGCF_PRESENT : 0));
            if (set == INVALID_HANDLE_VALUE) continue;
            SP_DEVINFO_DATA d = {sizeof(d)};
            for (DWORD i = 0; SetupDiEnumDeviceInfo(set, i, &d); i++) {
                wchar_t idw[512];
                if (CM_Get_Device_IDW(d.DevInst, idw, 512, 0) != CR_SUCCESS) continue;
                std::string id = Utf8(idw), mac = MacFrom(id);
                if (wcscmp(en, L"BTHLEDEVICE") == 0) {  // GATT service node: the address is on the parent
                    DEVINST parent;
                    wchar_t pid[512];
                    if (CM_Get_Parent(&parent, d.DevInst, 0) == CR_SUCCESS && CM_Get_Device_IDW(parent, pid, 512, 0) == CR_SUCCESS)
                        mac = MacFrom(Utf8(pid));
                }
                if (mac.empty() || mac == "00805f9b34fb") continue;
                BtReport& r = devs[mac];
                r.mac = mac;
                if (pass) { r.present = true; continue; }
                if (wcscmp(en, L"BTHENUM") != 0) r.le = true;
                std::string uuid = Between(id, "{", "}");
                if (!uuid.empty()) r.services.insert(BtServiceName(uuid));
                std::string up = id;
                for (auto& c : up) c = (char)toupper((unsigned char)c);
                std::string vid = Between(up, "VID&", "_"), pidv = Between(up, "PID&", "_");
                if (vid.size() >= 6 && r.vid.empty()) {
                    r.vidSource = vid.substr(0, vid.size() - 4);
                    r.vid = vid.substr(vid.size() - 4);
                    r.pid = pidv.substr(0, 4);
                }
                wchar_t name[256];
                DWORD type = 0;
                if (SetupDiGetDeviceRegistryPropertyW(set, &d, SPDRP_FRIENDLYNAME, &type, (BYTE*)name, sizeof(name), nullptr) ||
                    SetupDiGetDeviceRegistryPropertyW(set, &d, SPDRP_DEVICEDESC, &type, (BYTE*)name, sizeof(name), nullptr)) {
                    std::string n = Utf8(name);
                    // The device node ("...DEV_xxxx") carries the plain device name.
                    if (r.name.empty() || up.find("\\DEV_") != std::string::npos) r.name = n;
                }
                DEVPROPTYPE pt = 0;
                BYTE bat = 0;
                if (SetupDiGetDevicePropertyW(set, &d, &kBattery, &pt, &bat, 1, nullptr, 0) && pt == DEVPROP_TYPE_BYTE) r.battery = bat;
            }
            SetupDiDestroyDeviceInfoList(set);
        }
    }
    std::vector<BtReport> out;
    for (auto& kv : devs) out.push_back(kv.second);
    std::sort(out.begin(), out.end(), [](const BtReport& a, const BtReport& b) { return a.present > b.present; });
    return out;
}


// Plain-English read of what a device is and which app controls its extra
// features (ANC, game mode, EQ, rename). Informational only - SoundMesh does
// not send anything to the device. Proprietary features are changed by the
// maker's own app over the device's private channel; a generic PC tool that
// guessed those commands could stop the earbuds working, so this points to
// the right app instead of trying to drive the device blindly.
static std::string BtGuidance(const BtReport& r) {
    // Phones/PCs advertise "audio source"; they are not earbuds, so skip the earbud advice.
    for (auto& sv : r.services) if (sv.find("audio source") != std::string::npos) return std::string();
    std::string lname = Lower(r.name);
    unsigned vid = r.vid.empty() ? 0 : (unsigned)strtoul(r.vid.c_str(), nullptr, 16);
    bool byChip = r.vidSource.find('1') != std::string::npos;
    const char* chip = (byChip && vid) ? BtCompany(vid) : nullptr;
    bool jlChip = byChip && (vid == 0x05D6 || vid == 0x0642 || vid == 0x03E0 || vid == 0x02B0 || vid == 0x0094 || vid == 0x07E3);
    bool hasSamsungSvc = false;
    for (auto& sv : r.services) if (sv.find("594a34fc") != std::string::npos) hasSamsungSvc = true;  // Samsung Buds BLE service
    bool claimsBrand = lname.find("galaxy") != std::string::npos || lname.find("buds") != std::string::npos ||
                       lname.find("airpod") != std::string::npos || lname.find("sony") != std::string::npos ||
                       lname.find("wf-") != std::string::npos;

    std::string g = "    -> ";
    // Genuine brands with a known controller app.
    if (lname.find("soundcore") != std::string::npos || (chip && std::string(chip).find("JieLi") != std::string::npos && lname.find("r50i") != std::string::npos))
        return g + "Anker Soundcore. Control ANC / EQ / game (low-latency) mode in the free 'soundcore' app on the phone. No official PC app.\r\n";
    if (lname.find("galaxy") != std::string::npos && lname.find("buds") != std::string::npos && hasSamsungSvc)
        return g + "Genuine Samsung Buds. Use 'Galaxy Wearable' + 'Galaxy Buds' plugin on the phone for ANC, game mode and rename.\r\n";

    // Claims a famous brand but the radio does not match it -> clone.
    if (claimsBrand && !hasSamsungSvc && (jlChip || r.vid.empty())) {
        std::string why = r.vid.empty() ? "it reports no Samsung/Apple vendor ID or service"
                                         : std::string("its chip is ") + (chip ? chip : "a generic maker") + ", not the brand on the label";
        return g + "Named like a brand product but looks like a CLONE (" + why + ").\r\n"
               "       The real Galaxy Wearable / Apple app will NOT manage it. These clones are usually controlled by a\r\n"
               "       generic app the seller names - often 'HeyMelody', 'Fit', 'WeTune', 'ProBuds' or similar on the phone.\r\n"
               "       Game mode: usually a touch gesture (triple-tap or tap-and-hold ~2 s). No safe official PC control.\r\n";
    }
    if (jlChip)
        return g + std::string("Chip: ") + (chip ? chip : "generic") + ". Features (ANC / game mode) are set by the maker's own phone app\r\n"
               "       (whatever came with it, or try 'HeyMelody'). Game mode is often a triple-tap or tap-and-hold gesture.\r\n";
    if (chip)
        return g + std::string("Chip maker: ") + chip + ". Use that maker's companion app on the phone for extra features.\r\n";
    return std::string();
}

static std::string BluetoothReportText() {
    auto devs = BluetoothReport();
    std::string t = "SoundMesh " SM_VERSION " - Bluetooth devices known to this PC (read-only)\r\n\r\n";
    if (devs.empty()) t += "No Bluetooth devices found. Pair your earbuds in Bluetooth settings first.\r\n";
    for (auto& r : devs) {
        std::string mac;
        for (size_t i = 0; i < r.mac.size(); i += 2) mac += (i ? ":" : "") + r.mac.substr(i, 2);
        t += (r.name.empty() ? std::string("(no name)") : r.name) + "   [" + mac + "]" + (r.present ? "" : "  - not in range / off") +
             (r.le ? "  - Bluetooth LE" : "") + "\r\n";
        if (!r.vid.empty()) {
            unsigned vid = (unsigned)strtoul(r.vid.c_str(), nullptr, 16);
            const char* who = (r.vidSource.find('1') != std::string::npos) ? BtCompany(vid) : nullptr;
            t += "    chip/vendor ID: " + r.vid + " product " + r.pid + (who ? std::string("  = ") + who : r.vidSource.find('2') != std::string::npos ? "  (USB vendor ID)" : "") + "\r\n";
        } else t += "    chip/vendor ID: not reported by the device\r\n";
        if (r.battery >= 0) t += "    battery: " + std::to_string(r.battery) + "%\r\n";
        for (auto& s : r.services) t += "    - " + s + "\r\n";
        t += BtGuidance(r);
        t += "\r\n";
    }
    t += "The '->' line for each device says what it is and which phone app controls its ANC / game mode / rename.\r\n"
         "Those features use each maker's own private protocol, so there is no safe one-size-fits-all PC tool; the\r\n"
         "maker's app does it correctly. Paste this report back if you want help identifying a specific device.\r\n";
    return t;
}

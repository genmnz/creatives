// ---------------------------------------------------------------- GUI ------
// Plain Win32 window on top of the same engine. Included by soundmesh.cpp
// when SM_CONSOLE is not defined. Settings persist in soundmesh.ini next to
// the exe, so the app stays portable.
#include <commctrl.h>
#include <map>
extern "C" {
#include "third_party/qrcodegen.h"
}

enum {
    CTL_SOURCE = 100, CTL_LIST, CTL_SEL, CTL_DELAY, CTL_DELAYTXT, CTL_VOL, CTL_VOLTXT,
    CTL_NET, CTL_LATENCY, CTL_SMOOTH, CTL_AUTO, CTL_PHONEOUT, CTL_PHONEIN, CTL_MORE, CTL_HEADLINE, CTL_HINT,
    CTL_METER, CTL_VERIFY, CTL_SCREEN, CTL_BTINFO,
    CTL_I_SAVE, CTL_I_SOUND, CTL_I_DEVPRN,
    CTL_P_KEYS, CTL_P_BTSET, CTL_P_INFO, CTL_S_STATUS, CTL_S_PROJECT, CTL_S_FEATURE, CTL_S_TIPS, CTL_I_TEXT, CTL_I_COPY, CTL_I_REFRESH,
    CTL_P_WEB, CTL_P_URL, CTL_P_COUNT, CTL_P_BT, CTL_P_LIST, CTL_P_CONNECT, CTL_START, CTL_REFRESH, CTL_BT, CTL_HELP, CTL_LOG, CTL_LABEL
};
enum { COL_DEVICE, COL_STATUS, COL_DELAY, COL_VOLUME };
static const UINT_PTR kStatusTimer = 1;

struct DevPref {
    bool on = false;
    int delay = 0, vol = 100;
};
struct SrcItem {
    SrcKind kind;
    std::wstring id;  // empty loopback = whatever the Windows default device is
};

static HWND g_wnd, g_hSource, g_hList, g_hSel, g_hDelay, g_hDelayTxt, g_hVol, g_hVolTxt;
static HWND g_hAuto, g_hNet, g_hLat, g_hSmooth, g_hStart, g_hRefresh, g_hBt, g_hHelp, g_hLog;
static HWND g_lSource, g_lOut, g_lNet, g_lLat, g_lLog;
static HWND g_hHeadline, g_hHint, g_hPhoneOut, g_hPhoneIn, g_hMore, g_hMeter, g_hVerify, g_hScreen, g_hBtInfo;
static HWND g_pKeys, g_pBtSet, g_pInfo;                       // extra controls on the phone panels
static HWND g_panelScreen, g_sStatus, g_sProject, g_sFeature, g_sTips;  // "Phone screen on this PC"
static HWND g_panelInfo, g_iText, g_iCopy, g_iRefresh, g_iSave, g_iSound, g_iDevPrn;  // full report window
static std::wstring MiracastStatus();
static std::string FullReportText();
static ConnAudit g_audit;
static bool g_meterClean = true;  // nothing has gone outside the local network
static HWND g_panelOut, g_pWeb, g_pUrl, g_pCount, g_pTips;    // "Listen on my phone" window
static HWND g_panelIn, g_pBt, g_pList, g_pConnect, g_pInTips; // "Play my phone here" window
static std::vector<std::wstring> g_pIds;                      // phone ids shown in g_pList
static std::string g_qrText;                                  // what the QR code encodes
static std::vector<uint8_t> g_qr;                             // qrcodegen buffer
static bool g_showMore = false;
static int g_phonePort = 4011;
static std::wstring g_lastLine;
static HFONT g_font, g_bigFont;
static int g_dpi = 96;
static std::vector<DevInfo> g_play, g_rec;
static std::vector<SrcItem> g_srcItems;
static std::map<std::wstring, DevPref> g_prefs;
static SrcItem g_prefSrc{SRC_LOOPBACK, L""};
static bool g_engineOn = false, g_populating = false;
static int g_selRow = -1;
static int g_tick = 0;
static std::vector<bool> g_present;  // per row: device currently connected
static std::map<std::wstring, bool> g_autoDone;  // auto already ticked it this connection (so an untick sticks)

static void UpdateHeadline();
static void UpdatePhonePanels();
static void UpdateQr();

static bool AutoOn() { return SendMessageW(g_hAuto, BM_GETCHECK, 0, 0) == BST_CHECKED; }

static int S(int v) { return MulDiv(v, g_dpi, 96); }

static std::wstring Wide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

static std::string GetText(HWND h) {
    int n = GetWindowTextLengthW(h);
    std::wstring w(n + 1, L'\0');
    GetWindowTextW(h, &w[0], n + 1);
    w.resize(n);
    auto s = Utf8(w);
    while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
    while (!s.empty() && isspace((unsigned char)s.front())) s.erase(s.begin());
    return s;
}

// ------------------------------------------------------------ settings -----
static std::wstring IniPath() {
    wchar_t p[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH);
    std::wstring s(p, n);
    size_t slash = s.find_last_of(L"\\/");
    return s.substr(0, slash + 1) + L"soundmesh.ini";
}

static void SavePrefs() {
    FILE* f = _wfopen(IniPath().c_str(), L"wb");
    if (!f) return;  // read-only folder: just don't remember
    fprintf(f, "source=%d|%s\n", (int)g_prefSrc.kind, Utf8(g_prefSrc.id).c_str());
    fprintf(f, "net=%s\n", GetText(g_hNet).c_str());
    fprintf(f, "latency=%s\n", GetText(g_hLat).c_str());
    fprintf(f, "auto=%d\n", AutoOn() ? 1 : 0);
    fprintf(f, "more=%d\n", g_showMore ? 1 : 0);
    fprintf(f, "phones=%d\n", g_web && g_web->active ? 1 : 0);
    fprintf(f, "phoneport=%d\n", g_phonePort);
    fprintf(f, "phonein=%d\n", g_bt.on ? 1 : 0);
    fprintf(f, "phonekeys=%d\n", SendMessageW(g_pKeys, BM_GETCHECK, 0, 0) == BST_CHECKED ? 1 : 0);
    fprintf(f, "smooth=%d\n", SendMessageW(g_hSmooth, BM_GETCHECK, 0, 0) == BST_CHECKED ? 1 : 0);
    for (auto& kv : g_prefs)
        fprintf(f, "dev=%d|%d|%d|%s\n", kv.second.on ? 1 : 0, kv.second.delay, kv.second.vol, Utf8(kv.first).c_str());
    fclose(f);
}

static void LoadPrefs() {
    FILE* f = _wfopen(IniPath().c_str(), L"rb");
    if (!f) return;
    char line[1024];
    while (fgets(line, sizeof(line), f)) {
        std::string s(line);
        while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
        size_t eq = s.find('=');
        if (eq == std::string::npos) continue;
        std::string k = s.substr(0, eq), v = s.substr(eq + 1);
        if (k == "source") {
            size_t bar = v.find('|');
            if (bar == std::string::npos) continue;
            int kind = atoi(v.substr(0, bar).c_str());
            if (kind < SRC_LOOPBACK || kind > SRC_NET) continue;
            g_prefSrc = SrcItem{(SrcKind)kind, Wide(v.substr(bar + 1))};
        } else if (k == "net") SetWindowTextW(g_hNet, Wide(v).c_str());
        else if (k == "latency") SetWindowTextW(g_hLat, Wide(v).c_str());
        else if (k == "more") g_showMore = v == "1";
        else if (k == "phones") SendMessageW(g_pWeb, BM_SETCHECK, v == "1" ? BST_CHECKED : BST_UNCHECKED, 0);
        else if (k == "phoneport") g_phonePort = std::max(1, std::min(65535, atoi(v.c_str())));
        else if (k == "phonekeys") SendMessageW(g_pKeys, BM_SETCHECK, v == "1" ? BST_CHECKED : BST_UNCHECKED, 0);
        else if (k == "phonein") SendMessageW(g_pBt, BM_SETCHECK, v == "1" ? BST_CHECKED : BST_UNCHECKED, 0);
        else if (k == "auto") SendMessageW(g_hAuto, BM_SETCHECK, v == "1" ? BST_CHECKED : BST_UNCHECKED, 0);
        else if (k == "smooth") SendMessageW(g_hSmooth, BM_SETCHECK, v == "1" ? BST_CHECKED : BST_UNCHECKED, 0);
        else if (k == "dev") {
            auto p = Split(v, '|');
            if (p.size() < 4) continue;
            DevPref d;
            d.on = p[0] == "1";
            d.delay = std::max(0, std::min(2000, atoi(p[1].c_str())));
            d.vol = std::max(0, std::min(400, atoi(p[2].c_str())));
            // Device ids contain no '|', but rejoin just in case.
            std::string id = p[3];
            for (size_t i = 4; i < p.size(); i++) id += "|" + p[i];
            g_prefs[Wide(id)] = d;
        }
    }
    fclose(f);
}

// ------------------------------------------------------------- helpers -----
static void SetCell(int row, int col, const std::wstring& text) {
    wchar_t cur[128] = L"";
    LVITEMW get = {};
    get.iSubItem = col;
    get.pszText = cur;
    get.cchTextMax = 128;
    SendMessageW(g_hList, LVM_GETITEMTEXTW, row, (LPARAM)&get);
    if (text == cur) return;  // avoid needless repaints
    LVITEMW it = {};
    it.iSubItem = col;
    it.pszText = (LPWSTR)text.c_str();
    SendMessageW(g_hList, LVM_SETITEMTEXTW, row, (LPARAM)&it);
}

static std::wstring Fmt(const wchar_t* fmt, int v) {
    wchar_t b[64];
    swprintf(b, 64, fmt, v);
    return b;
}

static Output* OutputForRow(int row) {
    if (row < 0 || row >= (int)g_play.size()) return nullptr;
    for (auto* o : Outputs())
        if (o->dev.id == g_play[row].id) return o;
    return nullptr;
}

static std::wstring RowLabel(const DevInfo& d) {
    std::wstring name = Wide(d.name);
    if (IsHandsFree(d)) name += L"   (call mode, low quality - avoid)";
    else if (IsAutoHeadphone(d)) name += IsBluetooth(d) ? L"   [Bluetooth headphones]" : L"   [headphones]";
    if (d.isDefault) name += L"   (Windows default)";
    return name;
}

static void InsertRow(int i) {
    std::wstring name = RowLabel(g_play[i]);
    LVITEMW it = {};
    it.mask = LVIF_TEXT;
    it.iItem = i;
    it.pszText = (LPWSTR)name.c_str();
    SendMessageW(g_hList, LVM_INSERTITEMW, 0, (LPARAM)&it);
}

// The device chosen explicitly as source ("What plays on: X"), if any.
static std::wstring ExplicitSourceId() {
    int sel = (int)SendMessageW(g_hSource, CB_GETCURSEL, 0, 0);
    if (sel < 0 || sel >= (int)g_srcItems.size() || g_srcItems[sel].kind != SRC_LOOPBACK) return L"";
    return g_srcItems[sel].id;
}

// Tick every detected headphone. Ticking fires LVN_ITEMCHANGED, which also
// adds the output live when the engine is running.
static void AutoTick() {
    std::wstring src = ExplicitSourceId();
    for (int i = 0; i < (int)g_play.size(); i++) {
        if (!IsAutoHeadphone(g_play[i]) || g_play[i].id == src || !g_present[i] || g_autoDone[g_play[i].id]) continue;
        g_autoDone[g_play[i].id] = true;
        if (!ListView_GetCheckState(g_hList, i)) ListView_SetCheckState(g_hList, i, TRUE);
    }
}

static void RefreshRowSettings(int row) {
    const DevPref& p = g_prefs[g_play[row].id];
    SetCell(row, COL_DELAY, Fmt(L"%d ms", p.delay));
    SetCell(row, COL_VOLUME, Fmt(L"%d %%", p.vol));
}

static void UpdateSelControls() {
    bool ok = g_selRow >= 0 && g_selRow < (int)g_play.size();
    EnableWindow(g_hDelay, ok);
    EnableWindow(g_hVol, ok);
    if (!ok) {
        SetWindowTextW(g_hSel, L"Select a device to adjust it:");
        SetWindowTextW(g_hDelayTxt, L"");
        SetWindowTextW(g_hVolTxt, L"");
        return;
    }
    const DevPref& p = g_prefs[g_play[g_selRow].id];
    SetWindowTextW(g_hSel, (L"Adjust: " + Wide(g_play[g_selRow].name)).c_str());
    SendMessageW(g_hDelay, TBM_SETPOS, TRUE, p.delay);
    SendMessageW(g_hVol, TBM_SETPOS, TRUE, p.vol);
    SetWindowTextW(g_hDelayTxt, Fmt(L"delay %d ms", p.delay).c_str());
    SetWindowTextW(g_hVolTxt, Fmt(L"volume %d %%", p.vol).c_str());
}

static void Populate() {
    g_populating = true;
    SendMessageW(g_hSource, CB_RESETCONTENT, 0, 0);
    g_srcItems.clear();
    auto add = [](const std::wstring& text, SrcItem item) {
        SendMessageW(g_hSource, CB_ADDSTRING, 0, (LPARAM)text.c_str());
        g_srcItems.push_back(item);
    };
    std::string def = "none";
    for (auto& d : g_play) if (d.isDefault) def = d.name;
    add(L"What this PC plays  (Windows default: " + Wide(def) + L")", SrcItem{SRC_LOOPBACK, L""});
    for (auto& d : g_play)
        if (!IsHandsFree(d)) add(L"What plays on: " + Wide(d.name), SrcItem{SRC_LOOPBACK, d.id});
    for (auto& d : g_rec) add(L"Microphone: " + Wide(d.name), SrcItem{SRC_MIC, d.id});
    add(L"Another PC on the network  (LAN stream)", SrcItem{SRC_NET, L""});
    int sel = 0;
    for (size_t i = 0; i < g_srcItems.size(); i++)
        if (g_srcItems[i].kind == g_prefSrc.kind && g_srcItems[i].id == g_prefSrc.id) sel = (int)i;
    SendMessageW(g_hSource, CB_SETCURSEL, sel, 0);

    SendMessageW(g_hList, LVM_DELETEALLITEMS, 0, 0);
    g_present.assign(g_play.size(), true);
    for (size_t i = 0; i < g_play.size(); i++) {
        InsertRow((int)i);
        ListView_SetCheckState(g_hList, (int)i, g_prefs[g_play[i].id].on);
        RefreshRowSettings((int)i);
    }
    g_selRow = -1;
    UpdateSelControls();
    g_populating = false;
    if (AutoOn()) AutoTick();
}

// Runs every 2 s: notices headphones that were switched on / off. New
// devices are appended so rows (and running outputs) never shift.
static void DetectDevices() {
    auto now = ListDevices(eRender);
    std::vector<bool> present(g_play.size(), false);
    for (auto& d : now) {
        int row = -1;
        for (size_t i = 0; i < g_play.size(); i++)
            if (g_play[i].id == d.id) row = (int)i;
        if (row < 0) {
            g_play.push_back(d);
            present.push_back(true);
            g_present.push_back(true);
            row = (int)g_play.size() - 1;
            g_populating = true;
            InsertRow(row);
            RefreshRowSettings(row);
            g_populating = false;
            Log("Found: %s%s\n", d.name.c_str(), IsAutoHeadphone(d) ? "  (headphones)" : "");
            if (g_prefs[d.id].on) ListView_SetCheckState(g_hList, row, TRUE);  // ticked in an earlier session
        } else {
            present[row] = true;
            if (g_play[row].isDefault != d.isDefault || !g_present[row]) {
                g_play[row] = d;
                SetCell(row, COL_DEVICE, RowLabel(d));
            }
        }
    }
    for (size_t i = 0; i < g_play.size(); i++) {
        if (g_present[i] && !present[i]) {
            g_play[i].isDefault = false;
            SetCell((int)i, COL_DEVICE, RowLabel(g_play[i]));
        }
        bool cameBack = present[i] && !g_present[i];
        if (!present[i]) g_autoDone[g_play[i].id] = false;  // re-pick it when it reconnects
        g_present[i] = present[i];
        if (cameBack) Log("Connected: %s\n", g_play[i].name.c_str());
    }
    if (AutoOn()) AutoTick();

    // Earbuds in call mode (an app opened their microphone, or Windows picked the
    // Hands-Free endpoint) sound muffled: say so once per occurrence.
    static std::wstring warned;
    std::wstring now_hf;
    for (auto& d : g_play)
        if (d.isDefault && IsHandsFree(d)) now_hf = d.id;
    if (!now_hf.empty() && now_hf != warned)
        for (auto& d : g_play)
            if (d.id == now_hf)
                Log("! %s is in call mode (low quality). Pick its 'Headphones' entry as the Windows output, or disable the "
                    "Hands-Free entry: More options > Full report > Sound settings.\n", d.name.c_str());
    warned = now_hf;
}

// Status column for every row (also when stopped: shows unplugged devices).
static void UpdateStatus() {
    for (int i = 0; i < (int)g_play.size(); i++) {
        wchar_t b[96] = L"";
        Output* o = g_engineOn ? OutputForRow(i) : nullptr;
        if (i < (int)g_present.size() && !g_present[i]) swprintf(b, 96, L"not connected");
        else if (o && o->enabled) {
            int st = o->state;
            if (st == OS_PLAYING) swprintf(b, 96, L"playing  %d ms", (o->fillMs + 5) / 10 * 10);
            else if (st == OS_CONNECTING && g_src.kind == SRC_NET && !g_srcFrames) swprintf(b, 96, L"waiting for LAN");
            else swprintf(b, 96, L"%hs", kStateName[st]);
            uint32_t u = o->underruns;
            if (u && st != OS_DIRECT) swprintf(b + wcslen(b), 96 - wcslen(b), L"  (%u gaps)", u);
        }
        SetCell(i, COL_STATUS, b);
    }
}

static void UpdateUi() {
    SetWindowTextW(g_hStart, g_engineOn ? L"Stop" : L"Start");
    EnableWindow(g_hSource, !g_engineOn);
    EnableWindow(g_hNet, !g_engineOn);
    EnableWindow(g_hLat, !g_engineOn);
    EnableWindow(g_hSmooth, !g_engineOn);
    EnableWindow(g_hRefresh, !g_engineOn);
    if (!g_engineOn) {
        UpdateStatus();
        SetWindowTextW(g_wnd, L"SoundMesh");
    }
    UpdateHeadline();
}

static void OnStartStop();

static void UpdateHeadline() {
    wchar_t b[160];
    if (!g_engineOn) swprintf(b, 160, L"Stopped");
    else {
        int playing = 0, waiting = 0;
        std::wstring direct;
        for (auto* o : Outputs()) {
            if (!o->enabled) continue;
            if (o->isSource) direct = Wide(o->dev.name);
            else if (o->state == OS_PLAYING) playing++;
            else waiting++;
        }
        int phones = g_web && g_web->active ? g_web->nClients.load() : 0;
        std::wstring t = L"Playing on " + std::to_wstring(playing) + (playing == 1 ? L" device" : L" devices");
        if (!direct.empty()) t += L" + " + direct;
        if (phones) t += L" + " + std::to_wstring(phones) + (phones == 1 ? L" phone" : L" phones");
        if (!playing && direct.empty() && !phones) t = waiting ? L"Connecting..." : L"Waiting for headphones - switch them on";
        if (g_src.kind == SRC_NET && !g_srcFrames) t = L"Waiting for the other PC...";
        wcsncpy(b, t.c_str(), 159);
        b[159] = 0;
    }
    wchar_t cur[160] = L"";
    GetWindowTextW(g_hHeadline, cur, 160);
    if (wcscmp(cur, b)) SetWindowTextW(g_hHeadline, b);
}

static void SetPhoneIn(bool on);

static void UpdateMeter() {
    if (g_tick % 4 == 0) g_audit = AuditConnections();
    const uint64_t inet = g_bytesInternet, local = g_bytesLocal;
    std::string t;
    if (!inet && !g_audit.outside) {
        t = "Internet data used: 0 bytes.  Local network: " + FmtBytes(local) + ".  Open connections: " +
            std::to_string(g_audit.local) + (g_audit.local ? ", all inside your network." : ".");
    } else {
        char ip[32] = "";
        in_addr a;
        a.s_addr = g_lastInternetPeer;
        if (a.s_addr) inet_ntop(AF_INET, &a, ip, sizeof(ip));
        t = "WARNING: " + FmtBytes(inet) + " to/from outside your local network" + (ip[0] ? std::string(" (last: ") + ip + ")" : "") +
            (g_audit.outside ? ", open connection to " + g_audit.outsideAddr : "") + ". Check 'Send to LAN' addresses.";
    }
    bool clean = !inet && !g_audit.outside;
    std::wstring w = Wide(t);
    wchar_t cur[512] = L"";
    GetWindowTextW(g_hMeter, cur, 512);
    if (w != cur || clean != g_meterClean) {
        g_meterClean = clean;
        SetWindowTextW(g_hMeter, w.c_str());
        InvalidateRect(g_hMeter, nullptr, TRUE);
    }
}

static void OnTimer() {
    if (g_bt.thread && !g_bt.on) SetPhoneIn(false);  // the receiver stopped itself (e.g. not supported)
    UpdateMeter();
    UpdateHeadline();
    UpdatePhonePanels();
    if (g_tick % 20 == 0 && g_panelOut && IsWindowVisible(g_panelOut)) UpdateQr();  // address may change
    if (++g_tick % 4 == 0) DetectDevices();
    if (!g_engineOn) return;
    if (g_needRestart) {  // the captured device switched sample rate
        OnStartStop();
        OnStartStop();
        return;
    }
    if (!g_running) {  // engine stopped itself (e.g. UDP port busy)
        Stop();
        g_engineOn = false;
        UpdateUi();
        return;
    }
    UpdateStatus();
    wchar_t title[160], cur[160] = L"";
    if (g_src.kind == SRC_NET && !g_srcFrames) swprintf(title, 160, L"SoundMesh - waiting for a LAN stream...");
    else if (g_net && !g_net->dests.empty())
        swprintf(title, 160, L"SoundMesh - running  %u Hz  -> %zu LAN device(s)", g_rate.load(), g_net->dests.size());
    else swprintf(title, 160, L"SoundMesh - running  %u Hz", g_rate.load());
    GetWindowTextW(g_wnd, cur, 160);
    if (wcscmp(cur, title)) SetWindowTextW(g_wnd, title);
}

static void OnStartStop() {
    if (g_engineOn) {
        Stop();
        g_engineOn = false;
        UpdateUi();
        Log("Stopped.\n\n");
        return;
    }
    int sel = (int)SendMessageW(g_hSource, CB_GETCURSEL, 0, 0);
    if (sel < 0 || sel >= (int)g_srcItems.size()) sel = 0;
    const SrcItem& si = g_srcItems[sel];
    g_prefSrc = si;

    Options opt;
    opt.to.clear();
    opt.waitForDevices = AutoOn();
    if (si.kind == SRC_NET) opt.from = "net";
    else {
        const auto& devs = si.kind == SRC_MIC ? g_rec : g_play;
        opt.from = si.kind == SRC_MIC ? "mic" : "loop";
        for (size_t i = 0; i < devs.size(); i++)
            if (!si.id.empty() && devs[i].id == si.id) opt.from += ":" + std::to_string(i + 1);
    }
    for (size_t i = 0; i < g_play.size(); i++) {
        if (!ListView_GetCheckState(g_hList, (int)i)) continue;
        const DevPref& p = g_prefs[g_play[i].id];
        std::string n = std::to_string(i + 1);
        opt.to += (opt.to.empty() ? "" : ",") + n;
        opt.delays += (opt.delays.empty() ? "" : ",") + n + "=" + std::to_string(p.delay);
        opt.vols += (opt.vols.empty() ? "" : ",") + n + "=" + std::to_string(p.vol);
    }
    opt.net = GetText(g_hNet);
    std::string lat = GetText(g_hLat);
    opt.latency = lat.empty() ? -1 : atoi(lat.c_str());
    opt.deviceBuffer = SendMessageW(g_hSmooth, BM_GETCHECK, 0, 0) == BST_CHECKED ? 100 : 30;
    SavePrefs();

    if (!Start(opt, g_play, g_rec)) {
        MessageBoxW(g_wnd, Wide(g_lastError).c_str(), L"SoundMesh", MB_ICONWARNING);
        return;
    }
    g_engineOn = true;
    UpdateUi();
    OnTimer();
}

static void OnSlider(HWND tb) {
    if (g_selRow < 0 || g_selRow >= (int)g_play.size()) return;
    DevPref& p = g_prefs[g_play[g_selRow].id];
    int v = (int)SendMessageW(tb, TBM_GETPOS, 0, 0);
    if (tb == g_hDelay) p.delay = v;
    else p.vol = v;
    if (Output* o = OutputForRow(g_selRow)) {  // applies live while playing
        o->delayMs = p.delay;
        o->volPct = p.vol;
    }
    RefreshRowSettings(g_selRow);
    SetWindowTextW(g_hDelayTxt, Fmt(L"delay %d ms", p.delay).c_str());
    SetWindowTextW(g_hVolTxt, Fmt(L"volume %d %%", p.vol).c_str());
}

static void AppendLog() {
    std::string q;
    EnterCriticalSection(&g_logLock);
    q.swap(g_logQueue);
    LeaveCriticalSection(&g_logLock);
    if (q.empty()) return;
    std::string crlf;
    for (char c : q) {
        if (c == '\n') crlf += '\r';
        crlf += c;
    }
    std::wstring w = Wide(crlf);
    int len = GetWindowTextLengthW(g_hLog);
    if (len > 60000) {  // keep the log bounded
        SendMessageW(g_hLog, EM_SETSEL, 0, len / 2);
        SendMessageW(g_hLog, EM_REPLACESEL, FALSE, (LPARAM)L"");
        len = GetWindowTextLengthW(g_hLog);
    }
    SendMessageW(g_hLog, EM_SETSEL, len, len);
    SendMessageW(g_hLog, EM_REPLACESEL, FALSE, (LPARAM)w.c_str());
    // The newest non-empty line also shows under the headline.
    std::wstring t = w;
    while (!t.empty() && (t.back() == L'\n' || t.back() == L'\r' || t.back() == L' ')) t.pop_back();
    size_t nl = t.find_last_of(L'\n');
    t = nl == std::wstring::npos ? t : t.substr(nl + 1);
    while (!t.empty() && (t[0] == L' ' || t[0] == L'!')) t.erase(t.begin());
    if (!t.empty()) SetWindowTextW(g_hHint, t.c_str());
}

static const wchar_t* kVerifyHelp =
    L"You don't have to trust this app. Ways to check it with Windows itself:\n\n"
    L"1. Unplug the internet: pull the cable from the router's internet/WAN port (or switch off its "
    L"mobile data) and keep the router on. Headphones, phones over Wi-Fi and the Bluetooth receiver all keep working.\n\n"
    L"2. Resource Monitor: press Win+R, type  resmon , open the Network tab and tick soundmesh.exe "
    L"(process ID %u). 'TCP Connections' and 'Network Activity' list every address it talks to: only "
    L"192.168.x.x / 10.x.x.x / 172.16-31.x.x addresses should appear.\n\n"
    L"3. Command prompt:  netstat -ano | findstr %u   lists the same connections.\n\n"
    L"Note: Windows' 'Data usage' page also counts traffic inside your home network, so a few MB there "
    L"is not internet use - test 1 proves it.\n\n"
    L"By design SoundMesh never looks up a name (no DNS), has no update check, ads or telemetry, sends "
    L"network audio with TTL 1 (a router drops it instead of forwarding it), and refuses phone connections "
    L"from outside your local network. The meter counts every byte it sends or receives; anything not "
    L"addressed to a private home-network address is counted as internet.";

static const wchar_t* kNetworkHelp =
    L"Sending to other PCs / phones on your home network (never uses the internet):\n\n"
    L"In 'Send to LAN' type the receivers' IP addresses, comma separated "
    L"(e.g. 192.168.1.23, 192.168.1.40), or 'multicast' to reach all of them at once "
    L"(best over Ethernet; on Wi-Fi prefer IPs).\n\n"
    L"Receivers: another Windows PC runs SoundMesh with source 'Another PC on the network'; "
    L"Linux / Raspberry Pi / Android use a Scream receiver.\n\n"
    L"Router / Windows checklist:\n"
    L"  1. Same router and same Wi-Fi for everyone - not the Guest network.\n"
    L"  2. Router: turn OFF 'AP isolation' / 'Client isolation'.\n"
    L"  3. Windows: Settings > Network & internet > your network > Private network.\n"
    L"  4. Allow SoundMesh through the firewall when asked (UDP port 4010).\n"
    L"  5. Router: 'DHCP reservation' so receivers keep the same IP.\n\n"
    L"No media sharing, DLNA, UPnP, port forwarding or hotspot is needed.\n"
    L"Packets are sent with TTL 1, so a router can never forward them to the internet.";

// -------------------------------------------------------------- layout -----
static void Place(HWND h, int x, int y, int w, int hgt) { MoveWindow(h, x, y, std::max(1, w), std::max(1, hgt), TRUE); }

static HWND g_advanced[20];
static int g_nAdvanced = 0;

static void Layout() {
    RECT rc;
    GetClientRect(g_wnd, &rc);
    const int W = rc.right, H = rc.bottom, m = S(10), lineH = S(24), labelW = S(85);
    int y = m;

    // Headline + Start/Stop
    Place(g_hStart, W - m - S(120), y, S(120), S(34));
    Place(g_hHeadline, m, y, W - 3 * m - S(120), S(24));
    Place(g_hHint, m, y + S(24), W - 3 * m - S(120), S(18));
    y += S(48);
    Place(g_lOut, m, y + S(2), W - 2 * m - S(230), S(18));
    Place(g_hAuto, W - m - S(200), y, S(200), S(20));
    y += S(22);

    const int below = S(34) + S(42) + S(30) + (g_showMore ? S(32) + S(32) + S(38) + S(20) + S(130) : 0) + m;
    const int listH = std::max(S(100), H - y - below);
    Place(g_hList, m, y, W - 2 * m, listH);
    int colW = W - 2 * m - S(300) - GetSystemMetrics(SM_CXVSCROLL);
    ListView_SetColumnWidth(g_hList, COL_DEVICE, std::max(S(120), colW));
    ListView_SetColumnWidth(g_hList, COL_STATUS, S(160));
    ListView_SetColumnWidth(g_hList, COL_DELAY, S(65));
    ListView_SetColumnWidth(g_hList, COL_VOLUME, S(65));
    y += listH + S(8);

    // Adjust row: [label .......][delay slider][value][volume slider][value]
    int rest = W - 2 * m, txtW = S(95), sliders = std::min(S(380), rest / 2);
    int selW = rest - sliders - 2 * txtW;
    Place(g_hSel, m, y + S(4), selW, S(18));
    Place(g_hDelay, m + selW, y, sliders / 2, lineH);
    Place(g_hDelayTxt, m + selW + sliders / 2, y + S(4), txtW, S(18));
    Place(g_hVol, m + selW + sliders / 2 + txtW, y, sliders / 2, lineH);
    Place(g_hVolTxt, m + selW + sliders + txtW, y + S(4), txtW, S(18));
    y += S(34);

    // Main actions
    int bw = (W - 2 * m - 3 * S(8)) / 4, bh = S(32);
    Place(g_hPhoneOut, m, y, bw, bh);
    Place(g_hPhoneIn, m + (bw + S(8)), y, bw, bh);
    Place(g_hScreen, m + 2 * (bw + S(8)), y, bw, bh);
    Place(g_hMore, m + 3 * (bw + S(8)), y, bw, bh);
    y += S(40);
    Place(g_hVerify, W - m - S(150), y - S(2), S(150), S(24));
    Place(g_hMeter, m, y + S(2), W - 3 * m - S(150), S(18));
    y += S(32);

    for (int i = 0; i < g_nAdvanced; i++) ShowWindow(g_advanced[i], g_showMore ? SW_SHOW : SW_HIDE);
    SetWindowTextW(g_hMore, g_showMore ? L"Fewer options" : L"More options...");
    if (!g_showMore) return;

    Place(g_lSource, m, y + S(4), labelW, S(18));
    Place(g_hSource, m + labelW, y, W - 2 * m - labelW, S(300));
    y += S(32);
    int latW = S(55), latLabelW = S(80);
    Place(g_lNet, m, y + S(4), labelW, S(18));
    Place(g_hNet, m + labelW, y, W - 2 * m - labelW - latLabelW - latW - S(10), lineH);
    Place(g_lLat, W - m - latW - latLabelW, y + S(4), latLabelW, S(18));
    Place(g_hLat, W - m - latW, y, latW, lineH);
    y += S(32);
    Place(g_hRefresh, m, y, S(140), S(30));
    Place(g_hHelp, m + S(148), y, S(140), S(30));
    Place(g_hBt, m + S(296), y, S(150), S(30));
    Place(g_hBtInfo, m + S(454), y, S(150), S(30));
    y += S(38);
    Place(g_lLog, m, y, S(100), S(18));
    Place(g_hSmooth, W - m - S(190), y - S(2), S(190), S(20));
    y += S(20);
    Place(g_hLog, m, y, W - 2 * m, std::max(S(60), H - y - m));
}

static HWND Mk(const wchar_t* cls, const wchar_t* text, DWORD style, int id, DWORD ex = 0, HWND parent = nullptr) {
    HWND h = CreateWindowExW(ex, cls, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 10, 10, parent ? parent : g_wnd,
                             (HMENU)(INT_PTR)id, GetModuleHandleW(nullptr), nullptr);
    SendMessageW(h, WM_SETFONT, (WPARAM)g_font, TRUE);
    return h;
}

static void CreateControls() {
    g_hHeadline = Mk(L"STATIC", L"Stopped", SS_ENDELLIPSIS, CTL_HEADLINE);
    SendMessageW(g_hHeadline, WM_SETFONT, (WPARAM)g_bigFont, TRUE);
    g_hHint = Mk(L"STATIC", L"", SS_ENDELLIPSIS, CTL_HINT);
    g_hStart = Mk(L"BUTTON", L"Start", BS_DEFPUSHBUTTON | WS_TABSTOP, CTL_START);

    g_lOut = Mk(L"STATIC", L"Play on (tick or untick any time):", 0, CTL_LABEL);
    g_hAuto = Mk(L"BUTTON", L"Auto-pick headphones", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_AUTO);
    SendMessageW(g_hAuto, BM_SETCHECK, BST_CHECKED, 0);  // default on; soundmesh.ini may turn it off

    g_hList = Mk(WC_LISTVIEWW, L"", LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS | WS_TABSTOP, CTL_LIST, WS_EX_CLIENTEDGE);
    ListView_SetExtendedListViewStyle(g_hList, LVS_EX_CHECKBOXES | LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER);
    const wchar_t* cols[] = {L"Device", L"Status", L"Delay", L"Volume"};
    for (int i = 0; i < 4; i++) {
        LVCOLUMNW c = {};
        c.mask = LVCF_TEXT | LVCF_WIDTH;
        c.pszText = (LPWSTR)cols[i];
        c.cx = S(80);
        SendMessageW(g_hList, LVM_INSERTCOLUMNW, i, (LPARAM)&c);
    }

    g_hSel = Mk(L"STATIC", L"", SS_ENDELLIPSIS, CTL_SEL);
    g_hDelay = Mk(TRACKBAR_CLASSW, L"", TBS_HORZ | TBS_NOTICKS | WS_TABSTOP, CTL_DELAY);
    SendMessageW(g_hDelay, TBM_SETRANGE, TRUE, MAKELPARAM(0, 1000));
    SendMessageW(g_hDelay, TBM_SETLINESIZE, 0, 5);
    SendMessageW(g_hDelay, TBM_SETPAGESIZE, 0, 50);
    g_hDelayTxt = Mk(L"STATIC", L"", 0, CTL_DELAYTXT);
    g_hVol = Mk(TRACKBAR_CLASSW, L"", TBS_HORZ | TBS_NOTICKS | WS_TABSTOP, CTL_VOL);
    SendMessageW(g_hVol, TBM_SETRANGE, TRUE, MAKELPARAM(0, 200));
    SendMessageW(g_hVol, TBM_SETLINESIZE, 0, 1);
    SendMessageW(g_hVol, TBM_SETPAGESIZE, 0, 10);
    g_hVolTxt = Mk(L"STATIC", L"", 0, CTL_VOLTXT);

    g_hPhoneOut = Mk(L"BUTTON", L"Listen on my phone (Wi-Fi)...", WS_TABSTOP, CTL_PHONEOUT);
    g_hPhoneIn = Mk(L"BUTTON", L"Play my phone here (Bluetooth)...", WS_TABSTOP, CTL_PHONEIN);
    g_hScreen = Mk(L"BUTTON", L"Phone screen on this PC...", WS_TABSTOP, CTL_SCREEN);
    g_hMore = Mk(L"BUTTON", L"More options...", WS_TABSTOP, CTL_MORE);
    g_hMeter = Mk(L"STATIC", L"", SS_ENDELLIPSIS, CTL_METER);
    g_hVerify = Mk(L"BUTTON", L"Check it yourself...", WS_TABSTOP, CTL_VERIFY);

    // "More options"
    g_lSource = Mk(L"STATIC", L"Source:", 0, CTL_LABEL);
    g_hSource = Mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, CTL_SOURCE);
    g_lNet = Mk(L"STATIC", L"Send to LAN:", 0, CTL_LABEL);
    g_hNet = Mk(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, CTL_NET, WS_EX_CLIENTEDGE);
    SendMessageW(g_hNet, EM_SETCUEBANNER, TRUE, (LPARAM)L"off  -  or PCs running SoundMesh/Scream: 192.168.1.23, ...  -  or multicast");
    g_lLat = Mk(L"STATIC", L"Latency ms:", 0, CTL_LABEL);
    g_hLat = Mk(L"EDIT", L"", ES_AUTOHSCROLL | ES_NUMBER | WS_TABSTOP, CTL_LATENCY, WS_EX_CLIENTEDGE);
    SendMessageW(g_hLat, EM_SETCUEBANNER, TRUE, (LPARAM)L"auto");
    g_hRefresh = Mk(L"BUTTON", L"Refresh devices", WS_TABSTOP, CTL_REFRESH);
    g_hHelp = Mk(L"BUTTON", L"Network help...", WS_TABSTOP, CTL_HELP);
    g_hSmooth = Mk(L"BUTTON", L"Smooth mode (+70 ms)", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_SMOOTH);
    g_hBt = Mk(L"BUTTON", L"Bluetooth settings...", WS_TABSTOP, CTL_BT);
    g_hBtInfo = Mk(L"BUTTON", L"Full report / earbuds...", WS_TABSTOP, CTL_BTINFO);
    g_lLog = Mk(L"STATIC", L"Log:", 0, CTL_LABEL);
    g_hLog = Mk(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, CTL_LOG, WS_EX_CLIENTEDGE);
    for (HWND h : {g_lSource, g_hSource, g_lNet, g_hNet, g_lLat, g_hLat, g_hRefresh, g_hHelp, g_hBt, g_hBtInfo, g_hSmooth, g_lLog, g_hLog})
        g_advanced[g_nAdvanced++] = h;
}

// --------------------------------------------------------- phone panels ----
static const wchar_t* kPhoneOutTips =
    L"1. Connect the phone to the same Wi-Fi as this PC (no internet needed).\r\n"
    L"2. Scan the code with the phone camera, or type the address in its browser.\r\n"
    L"3. Tap Play. Use the page's Delay slider to line it up with the headphones.\r\n\r\n"
    L"Keep the page open and the screen on. Windows may ask to allow SoundMesh "
    L"through the firewall: allow it on Private networks.\r\n\r\n"
    L"VLC, smart TVs and Wi-Fi speakers that can open a URL: use .../stream.wav\r\n"
    L"The page's buttons pause / skip what plays on the PC (YouTube, Spotify...).";

static const wchar_t* kScreenTips =
    L"Uses Miracast, which is built into Windows and most Android phones: phone and PC connect "
    L"directly over Wi-Fi (Wi-Fi Direct). No router, no internet, nothing to install on the phone. "
    L"The phone's sound comes along and SoundMesh sends it on to your headphones.\r\n\r\n"
    L"Once: click 1 and add the free 'Wireless Display' feature. Click 2 and set "
    L"'Some Windows and Android devices can project...' to 'Available everywhere', "
    L"'Ask to project' to 'First time only' and 'Require PIN' to 'Never'.\r\n\r\n"
    L"Each time: open 'Wireless Display' from the Start menu (the PC now waits), then on the phone "
    L"pull down quick settings and tap Smart View / Screen Cast / Cast / Wireless projection / Mirror "
    L"screen, and pick this PC.\r\n\r\n"
    L"Samsung, Xiaomi, OnePlus, OPPO, Realme, vivo, Huawei support it. Google Pixel phones do not "
    L"(Pixel can only cast to Chromecast).";

// Ask Windows whether the Wi-Fi adapter and graphics driver can receive Miracast.
static std::wstring MiracastStatus() {
    SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return L"";
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW si = {sizeof(si)};
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = si.hStdError = wr;
    PROCESS_INFORMATION pi = {};
    wchar_t cmd[] = L"netsh.exe wlan show drivers";
    std::string out;
    if (CreateProcessW(nullptr, cmd, nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        CloseHandle(wr);
        wr = nullptr;
        char buf[4096];
        DWORD n;
        while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n) out.append(buf, n);
        WaitForSingleObject(pi.hProcess, 5000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }
    if (wr) CloseHandle(wr);
    CloseHandle(rd);
    // English line: "Wireless Display Supported: Yes (Graphics Driver: Yes, Wi-Fi Driver: Yes)"
    for (size_t p = 0; p < out.size();) {
        size_t e = out.find('\n', p);
        std::string line = out.substr(p, e == std::string::npos ? std::string::npos : e - p);
        p = e == std::string::npos ? out.size() : e + 1;
        std::string l = Lower(line);
        if (l.find("wireless display") == std::string::npos && l.find("miracast") == std::string::npos) continue;
        size_t c = line.find(':');
        std::string v = c == std::string::npos ? line : line.substr(c + 1);
        while (!v.empty() && isspace((unsigned char)v.front())) v.erase(v.begin());
        while (!v.empty() && isspace((unsigned char)v.back())) v.pop_back();
        if (Lower(v).rfind("yes", 0) == 0) return L"This PC can show phone screens (Miracast supported).";
        if (Lower(v).rfind("no", 0) == 0)
            return L"This PC's Wi-Fi or graphics driver can't receive Miracast: " + Wide(v) + L". Updating the Wi-Fi driver sometimes helps.";
        return L"Miracast: " + Wide(v);
    }
    return out.empty() ? L"Couldn't ask Windows about Miracast (is Wi-Fi on?)." : L"Couldn't read Miracast support - try it anyway.";
}

static const wchar_t* kPhoneInTips =
    L"Makes this PC a Bluetooth speaker for your phone; its sound goes on to all ticked headphones. "
    L"Needs Windows 10 (2004) or 11.\r\n\r\n"
    L"PC says 'Connected' but the phone says it can't connect?\r\n"
    L"The phone learned what this PC can do when you paired - before the PC could act as a speaker. "
    L"Fix, once:\r\n"
    L"1. Tick the box above first.\r\n"
    L"2. On the phone: Bluetooth > this PC > Forget / Unpair. On the PC: remove the phone.\r\n"
    L"3. Pair again, then pick the phone here and press Connect (or tap the PC on the phone and turn on 'Media audio').\r\n"
    L"Also: close Phone Link if it holds the phone, and switch off one headphone if 2+ are connected - "
    L"one Bluetooth radio carries everything.";

static void UpdateQr() {
    std::string url;
    std::wstring all;
    for (auto& ip : LocalIPv4s()) {
        std::string u = "http://" + ip.ip + ":" + std::to_string(g_phonePort);
        if (url.empty()) url = u;
        all += Wide(u) + L"   (" + Wide(ip.adapter) + L")\r\n";
    }
    if (url.empty()) all = L"This PC has no network address. Connect it to your Wi-Fi first.";
    if (!(g_web && g_web->active)) all = L"Tick the box above to let phones listen.";
    SetWindowTextW(g_pUrl, all.c_str());
    InvalidateRect(g_panelOut, nullptr, TRUE);  // sharing may have been switched on/off
    if (url == g_qrText && !g_qr.empty()) return;
    g_qrText = url;
    g_qr.assign(qrcodegen_BUFFER_LEN_MAX, 0);
    std::vector<uint8_t> tmp(qrcodegen_BUFFER_LEN_MAX);
    if (url.empty() || !qrcodegen_encodeText(url.c_str(), tmp.data(), g_qr.data(), qrcodegen_Ecc_MEDIUM, qrcodegen_VERSION_MIN,
                                              qrcodegen_VERSION_MAX, qrcodegen_Mask_AUTO, true))
        g_qr.clear();
    InvalidateRect(g_panelOut, nullptr, TRUE);
}

static void UpdatePhonePanels() {
    if (g_panelOut && IsWindowVisible(g_panelOut)) {
        wchar_t b[96];
        int n = g_web && g_web->active ? g_web->nClients.load() : 0;
        if (!(g_web && g_web->active)) swprintf(b, 96, L"Off");
        else if (!g_engineOn) swprintf(b, 96, L"%d listening - press Start in the main window to send sound", n);
        else swprintf(b, 96, n == 1 ? L"%d phone listening" : L"%d phones listening", n);
        SetWindowTextW(g_pCount, b);
    }
    if (g_panelIn && IsWindowVisible(g_panelIn)) {
        std::vector<std::wstring> ids;
        std::vector<std::wstring> rows;
        EnterCriticalSection(&g_bt.lock);
        for (auto* p : g_bt.phones) {
            ids.push_back(p->id);
            rows.push_back(Wide(p->name) + (p->state ? L"   -  connected, playing here" : L"   -  ready"));
        }
        LeaveCriticalSection(&g_bt.lock);
        if (!g_bt.on) rows.assign(1, g_bt.supported ? L"(off)" : L"(not supported on this Windows)"), ids.assign(1, L"");
        else if (rows.empty()) rows.assign(1, L"(looking for paired phones...)"), ids.assign(1, L"");
        bool same = (int)SendMessageW(g_pList, LB_GETCOUNT, 0, 0) == (int)rows.size() && ids == g_pIds;
        for (size_t i = 0; same && i < rows.size(); i++) {
            wchar_t cur[256] = L"";
            if (SendMessageW(g_pList, LB_GETTEXTLEN, i, 0) < 255) SendMessageW(g_pList, LB_GETTEXT, i, (LPARAM)cur);
            same = rows[i] == cur;
        }
        if (!same) {
            int sel = (int)SendMessageW(g_pList, LB_GETCURSEL, 0, 0);
            SendMessageW(g_pList, LB_RESETCONTENT, 0, 0);
            for (auto& r : rows) SendMessageW(g_pList, LB_ADDSTRING, 0, (LPARAM)r.c_str());
            if (sel >= 0 && sel < (int)rows.size()) SendMessageW(g_pList, LB_SETCURSEL, sel, 0);
            g_pIds = ids;
        }
    }
}

static void SetPhonesListening(bool on) {
    if (on) {
        if (!StartWeb(g_phonePort)) on = false;
        else {
            g_web->remoteKeys = SendMessageW(g_pKeys, BM_GETCHECK, 0, 0) == BST_CHECKED;
            Log("Phones can listen: open http://<this PC>:%d on the phone (Listen on my phone... shows a QR code).\n", g_phonePort);
        }
    } else StopWeb();
    SendMessageW(g_pWeb, BM_SETCHECK, on ? BST_CHECKED : BST_UNCHECKED, 0);
    SetWindowTextW(g_hPhoneOut, on ? L"Listen on my phone (Wi-Fi): on" : L"Listen on my phone (Wi-Fi)...");
    UpdateQr();
    UpdatePhonePanels();
}

static void SetPhoneIn(bool on) {
    if (on) on = StartBtSink();
    else StopBtSink();
    SendMessageW(g_pBt, BM_SETCHECK, on ? BST_CHECKED : BST_UNCHECKED, 0);
    SetWindowTextW(g_hPhoneIn, on ? L"Play my phone here (Bluetooth): on" : L"Play my phone here (Bluetooth)...");
    UpdatePhonePanels();
}

static LRESULT CALLBACK PanelProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_CLOSE: ShowWindow(h, SW_HIDE); return 0;
        case WM_COMMAND:
            switch (LOWORD(wp)) {
                case CTL_P_WEB: SetPhonesListening(SendMessageW(g_pWeb, BM_GETCHECK, 0, 0) == BST_CHECKED); SavePrefs(); break;
                case CTL_P_BT:
                    if (SendMessageW(g_pBt, BM_GETCHECK, 0, 0) != BST_CHECKED && g_bt.on) SetWindowTextW(g_pInTips, L"Turning off...");
                    SetPhoneIn(SendMessageW(g_pBt, BM_GETCHECK, 0, 0) == BST_CHECKED);
                    SetWindowTextW(g_pInTips, kPhoneInTips);
                    SavePrefs();
                    break;
                case CTL_P_KEYS:
                    if (g_web) g_web->remoteKeys = SendMessageW(g_pKeys, BM_GETCHECK, 0, 0) == BST_CHECKED;
                    SavePrefs();
                    break;
                case CTL_P_BTSET: OpenBluetoothSettings(); break;
                case CTL_P_INFO:
                case CTL_I_REFRESH: {
                    SetWindowTextW(g_iText, L"Collecting...");
                    SetWindowTextW(g_iCopy, L"Copy report");
                    ShowWindow(g_panelInfo, SW_SHOW);
                    SetForegroundWindow(g_panelInfo);
                    UpdateWindow(g_panelInfo);
                    SetWindowTextW(g_iText, Wide(FullReportText()).c_str());
                    break;
                }
                case CTL_I_SAVE: {
                    std::wstring path = ExeDir() + L"soundmesh-report.txt";
                    FILE* f = _wfopen(path.c_str(), L"wb");
                    if (f) {
                        int n = GetWindowTextLengthW(g_iText);
                        std::wstring w(n + 1, L'\0');
                        GetWindowTextW(g_iText, &w[0], n + 1);
                        w.resize(n);
                        std::string u = Utf8(w);
                        fwrite("\xEF\xBB\xBF", 1, 3, f);  // UTF-8 BOM so Notepad shows names correctly
                        fwrite(u.data(), 1, u.size(), f);
                        fclose(f);
                        ShellExecuteW(nullptr, L"open", L"explorer.exe", (L"/select,\"" + path + L"\"").c_str(), nullptr, SW_SHOWNORMAL);
                    } else MessageBoxW(h, L"Can't write next to the exe. Use Copy report instead.", L"SoundMesh", MB_ICONWARNING);
                    break;
                }
                case CTL_I_SOUND: ShellExecuteW(nullptr, L"open", L"control.exe", L"mmsys.cpl", nullptr, SW_SHOWNORMAL); break;
                case CTL_I_DEVPRN:
                    ShellExecuteW(nullptr, L"open", L"explorer.exe", L"shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}", nullptr, SW_SHOWNORMAL);
                    break;
                case CTL_I_COPY: {
                    int n = GetWindowTextLengthW(g_iText);
                    HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, (n + 1) * sizeof(wchar_t));
                    if (mem && OpenClipboard(h)) {
                        GetWindowTextW(g_iText, (wchar_t*)GlobalLock(mem), n + 1);
                        GlobalUnlock(mem);
                        EmptyClipboard();
                        SetClipboardData(CF_UNICODETEXT, mem);
                        CloseClipboard();
                        SetWindowTextW(g_iCopy, L"Copied");
                    } else if (mem) GlobalFree(mem);
                    break;
                }
                case CTL_S_FEATURE: ShellExecuteW(nullptr, L"open", L"ms-settings:optionalfeatures", nullptr, nullptr, SW_SHOWNORMAL); break;
                case CTL_S_PROJECT: ShellExecuteW(nullptr, L"open", L"ms-settings:project", nullptr, nullptr, SW_SHOWNORMAL); break;
                case CTL_P_CONNECT: {
                    int sel = (int)SendMessageW(g_pList, LB_GETCURSEL, 0, 0);
                    if (sel >= 0 && sel < (int)g_pIds.size() && !g_pIds[sel].empty()) BtConnect(g_pIds[sel]);
                    else MessageBeep(MB_OK);
                    break;
                }
            }
            return 0;
        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC dc = BeginPaint(h, &ps);
            if (h == g_panelOut && !g_qr.empty() && g_web && g_web->active) {
                // QR code, 4-module quiet zone, centred
                int n = qrcodegen_getSize(g_qr.data()), cell = std::max(2, S(200) / (n + 8));
                RECT rc;
                GetClientRect(h, &rc);
                int total = (n + 8) * cell, x0 = (rc.right - total) / 2, y0 = S(44);
                RECT bg = {x0, y0, x0 + total, y0 + total};
                FillRect(dc, &bg, (HBRUSH)GetStockObject(WHITE_BRUSH));
                for (int y = 0; y < n; y++)
                    for (int x = 0; x < n; x++)
                        if (qrcodegen_getModule(g_qr.data(), x, y)) {
                            RECT r = {x0 + (x + 4) * cell, y0 + (y + 4) * cell, x0 + (x + 5) * cell, y0 + (y + 5) * cell};
                            FillRect(dc, &r, (HBRUSH)GetStockObject(BLACK_BRUSH));
                        }
            }
            EndPaint(h, &ps);
            return 0;
        }
    }
    return DefWindowProcW(h, msg, wp, lp);
}

// Everything useful for helping from a distance, in one block of text.
// Contains device names, Bluetooth and local IP addresses - no passwords.
static std::string FullReportText() {
    std::string t;
    auto line = [&](const std::string& s) { t += s + "\r\n"; };
    SYSTEMTIME st;
    GetLocalTime(&st);
    char b[512];
    snprintf(b, sizeof(b), "===== SoundMesh %s report  %04d-%02d-%02d %02d:%02d =====", SM_VERSION, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute);
    line(b);

    // Windows version (RtlGetVersion tells the truth; GetVersionEx does not)
    typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW*);
    OSVERSIONINFOW vi = {sizeof(vi)};
    if (auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")) fn(&vi);
    snprintf(b, sizeof(b), "Windows %lu.%lu build %lu%s", vi.dwMajorVersion, vi.dwMinorVersion, vi.dwBuildNumber,
             vi.dwBuildNumber >= 22000 ? " (Windows 11)" : vi.dwBuildNumber >= 19041 ? " (Windows 10 2004+)" : "");
    line(b);

    line("");
    line("--- Engine ---");
    if (!g_engineOn) line("stopped");
    else {
        const char* kind = g_src.kind == SRC_NET ? "LAN stream" : (g_src.kind == SRC_MIC ? "microphone" : "loopback");
        snprintf(b, sizeof(b), "source: %s '%s'%s, %u Hz, %.0f s received, base latency %d ms, device buffer %d ms", kind,
                 g_src.dev.name.c_str(), g_src.followDefault ? " (follows Windows default)" : "", g_rate.load(),
                 (double)g_srcFrames / std::max(1u, g_rate.load()), g_baseLatencyMs.load(), g_deviceBufferMs.load());
        line(b);
        for (auto* o : Outputs()) {
            snprintf(b, sizeof(b), "output '%s': %s%s, buffer %d ms, delay %d ms, volume %d%%, gaps %u", o->dev.name.c_str(),
                     kStateName[o->state], o->enabled ? "" : " (unticked)", o->fillMs.load(), o->delayMs.load(), o->volPct.load(),
                     o->underruns.load());
            line(b);
        }
        if (g_net)
            for (auto& d : g_net->dests) {
                char ip[32];
                inet_ntop(AF_INET, &d.sin_addr, ip, sizeof(ip));
                line(std::string("LAN output ") + ip + " (" + std::to_string(g_net->packets) + " packets)");
            }
    }

    line("");
    line("--- Audio devices (bus / form factor: 1 speakers, 3 headphones, 5 headset) ---");
    for (auto& d : ListDevices(eRender)) {
        snprintf(b, sizeof(b), "play: %s | bus %s | form %d%s%s%s", d.name.c_str(), d.bus.empty() ? "?" : d.bus.c_str(), d.formFactor,
                 d.isDefault ? " | Windows default" : "", IsHandsFree(d) ? " | CALL MODE endpoint" : "",
                 IsAutoHeadphone(d) ? " | auto-picked as headphones" : "");
        line(b);
    }
    for (auto& d : ListDevices(eCapture)) {
        snprintf(b, sizeof(b), "mic:  %s | bus %s%s", d.name.c_str(), d.bus.empty() ? "?" : d.bus.c_str(), d.isDefault ? " | Windows default" : "");
        line(b);
    }

    line("");
    line("--- Phones ---");
    if (g_web && g_web->active)
        snprintf(b, sizeof(b), "Wi-Fi listening: on, port %d, %d connected, media keys %s", g_web->port, g_web->nClients.load(),
                 g_web->remoteKeys ? "allowed" : "off");
    else snprintf(b, sizeof(b), "Wi-Fi listening: off");
    line(b);
    std::string bt = g_bt.on ? "on" : (g_bt.supported ? "off" : "not supported on this Windows");
    line("Bluetooth receiver: " + bt);
    EnterCriticalSection(&g_bt.lock);
    for (auto* p : g_bt.phones) line("  phone '" + p->name + "': " + (p->state ? "connected" : "ready"));
    LeaveCriticalSection(&g_bt.lock);
    line("Miracast: " + Utf8(MiracastStatus()));

    line("");
    line("--- Network ---");
    for (auto& ip : LocalIPv4s()) line("address " + ip.ip + " on '" + ip.adapter + "'" + (ip.wifi ? " (Wi-Fi)" : ""));
    ConnAudit au = AuditConnections();
    snprintf(b, sizeof(b), "data meter: %s local, %s internet; open connections %d, outside the local network %d%s%s",
             FmtBytes(g_bytesLocal).c_str(), FmtBytes(g_bytesInternet).c_str(), au.local + au.outside, au.outside,
             au.outside ? " -> " : "", au.outsideAddr.c_str());
    line(b);

    line("");
    line("--- Settings (soundmesh.ini) ---");
    SavePrefs();
    if (FILE* f = _wfopen(IniPath().c_str(), L"rb")) {
        char l[1024];
        while (fgets(l, sizeof(l), f)) {
            std::string s(l);
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            line("  " + s);
        }
        fclose(f);
    }

    line("");
    line("--- Bluetooth devices ---");
    t += BluetoothReportText();

    line("");
    line("--- Log, this session ---");
    int n = GetWindowTextLengthW(g_hLog);
    std::wstring w(n + 1, L'\0');
    GetWindowTextW(g_hLog, &w[0], n + 1);
    w.resize(n);
    t += Utf8(w);

    line("");
    line("--- Log history (soundmesh-log.txt, last 400 lines) ---");
    for (const wchar_t* name : {L"soundmesh-log.old.txt", L"soundmesh-log.txt"}) {
        FILE* f = _wfopen((ExeDir() + name).c_str(), L"rb");
        if (!f) continue;
        std::vector<std::string> lines;
        char l[1200];
        while (fgets(l, sizeof(l), f)) lines.push_back(l);
        fclose(f);
        if (wcscmp(name, L"soundmesh-log.old.txt") == 0 && lines.size() > 100) lines.erase(lines.begin(), lines.end() - 100);
        if (lines.size() > 300) lines.erase(lines.begin(), lines.end() - 300);
        for (auto& s : lines) {
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            line(s);
        }
    }
    line("===== end of report =====");
    return t;
}

static HWND MakePanel(const wchar_t* title, int w, int hgt) {
    RECT r = {0, 0, S(w), S(hgt)};
    AdjustWindowRect(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE);
    return CreateWindowExW(0, L"SoundMeshPanel", title, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT,
                           r.right - r.left, r.bottom - r.top, g_wnd, nullptr, GetModuleHandleW(nullptr), nullptr);
}

static void CreatePanels() {
    const int m = S(12);
    g_panelOut = MakePanel(L"Listen on my phone (Wi-Fi)", 440, 562);
    g_pWeb = Mk(L"BUTTON", L"Let phones listen over Wi-Fi", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_P_WEB, 0, g_panelOut);
    Place(g_pWeb, m, m, S(416), S(22));
    // QR code is painted at y = 44 .. 44 + ~200
    g_pUrl = Mk(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_CENTER, CTL_P_URL, 0, g_panelOut);
    Place(g_pUrl, m, S(254), S(416), S(58));
    g_pCount = Mk(L"STATIC", L"Off", SS_CENTER, CTL_P_COUNT, 0, g_panelOut);
    SendMessageW(g_pCount, WM_SETFONT, (WPARAM)g_bigFont, TRUE);
    Place(g_pCount, m, S(316), S(416), S(26));
    g_pTips = Mk(L"STATIC", kPhoneOutTips, 0, CTL_LABEL, 0, g_panelOut);
    Place(g_pTips, m, S(352), S(416), S(170));
    g_pKeys = Mk(L"BUTTON", L"Phones may pause / skip what plays on this PC", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_P_KEYS, 0, g_panelOut);
    SendMessageW(g_pKeys, BM_SETCHECK, BST_CHECKED, 0);
    Place(g_pKeys, m, S(528), S(416), S(22));

    g_panelIn = MakePanel(L"Play my phone here (Bluetooth)", 440, 460);
    g_pBt = Mk(L"BUTTON", L"Let my phone play through this PC", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_P_BT, 0, g_panelIn);
    Place(g_pBt, m, m, S(416), S(22));
    g_pList = Mk(L"LISTBOX", L"", LBS_NOTIFY | WS_VSCROLL | WS_TABSTOP, CTL_P_LIST, WS_EX_CLIENTEDGE, g_panelIn);
    Place(g_pList, m, S(42), S(416), S(110));
    g_pConnect = Mk(L"BUTTON", L"Connect", WS_TABSTOP, CTL_P_CONNECT, 0, g_panelIn);
    Place(g_pConnect, S(440) - m - S(110), S(158), S(110), S(28));
    g_pBtSet = Mk(L"BUTTON", L"Bluetooth settings...", WS_TABSTOP, CTL_P_BTSET, 0, g_panelIn);
    Place(g_pBtSet, m, S(158), S(150), S(28));
    g_pInfo = Mk(L"BUTTON", L"Full report...", WS_TABSTOP, CTL_P_INFO, 0, g_panelIn);
    Place(g_pInfo, m + S(158), S(158), S(120), S(28));
    g_pInTips = Mk(L"STATIC", kPhoneInTips, 0, CTL_LABEL, 0, g_panelIn);
    Place(g_pInTips, m, S(196), S(416), S(256));

    // Phone screen on this PC (Miracast - built into Windows and most Android phones)
    g_panelScreen = MakePanel(L"Phone screen on this PC (Wi-Fi)", 460, 470);
    g_sStatus = Mk(L"STATIC", L"", 0, CTL_S_STATUS, 0, g_panelScreen);
    SendMessageW(g_sStatus, WM_SETFONT, (WPARAM)g_bigFont, TRUE);
    Place(g_sStatus, m, m, S(436), S(52));
    g_sFeature = Mk(L"BUTTON", L"1. Add 'Wireless Display'...", WS_TABSTOP, CTL_S_FEATURE, 0, g_panelScreen);
    Place(g_sFeature, m, S(70), S(212), S(30));
    g_sProject = Mk(L"BUTTON", L"2. Projecting to this PC...", WS_TABSTOP, CTL_S_PROJECT, 0, g_panelScreen);
    Place(g_sProject, m + S(224), S(70), S(212), S(30));
    g_sTips = Mk(L"STATIC", kScreenTips, 0, CTL_S_TIPS, 0, g_panelScreen);
    Place(g_sTips, m, S(112), S(436), S(350));

    // Bluetooth device report
    g_panelInfo = MakePanel(L"SoundMesh report (devices, earbuds, network, log)", 640, 560);
    g_iText = Mk(L"EDIT", L"", ES_MULTILINE | ES_READONLY | WS_VSCROLL | WS_HSCROLL | ES_AUTOVSCROLL | ES_AUTOHSCROLL,
                 CTL_I_TEXT, WS_EX_CLIENTEDGE, g_panelInfo);
    Place(g_iText, m, m, S(616), S(492));
    SendMessageW(g_iText, EM_SETLIMITTEXT, 4 * 1024 * 1024, 0);
    g_iRefresh = Mk(L"BUTTON", L"Refresh", WS_TABSTOP, CTL_I_REFRESH, 0, g_panelInfo);
    Place(g_iRefresh, m, S(514), S(80), S(30));
    g_iSound = Mk(L"BUTTON", L"Sound settings...", WS_TABSTOP, CTL_I_SOUND, 0, g_panelInfo);
    Place(g_iSound, m + S(88), S(514), S(120), S(30));
    g_iDevPrn = Mk(L"BUTTON", L"Devices and Printers...", WS_TABSTOP, CTL_I_DEVPRN, 0, g_panelInfo);
    Place(g_iDevPrn, m + S(216), S(514), S(150), S(30));
    g_iSave = Mk(L"BUTTON", L"Save to file", WS_TABSTOP, CTL_I_SAVE, 0, g_panelInfo);
    Place(g_iSave, S(640) - m - S(236), S(514), S(110), S(30));
    g_iCopy = Mk(L"BUTTON", L"Copy report", WS_TABSTOP, CTL_I_COPY, 0, g_panelInfo);
    Place(g_iCopy, S(640) - m - S(118), S(514), S(118), S(30));
}

static void ShowPanel(HWND p) {
    UpdateQr();
    UpdatePhonePanels();
    ShowWindow(p, SW_SHOW);
    SetForegroundWindow(p);
}

// -------------------------------------------------------------- window -----
static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE: Layout(); return 0;
        case WM_GETMINMAXINFO: {
            MINMAXINFO* mm = (MINMAXINFO*)lp;
            mm->ptMinTrackSize.x = S(760);
            mm->ptMinTrackSize.y = g_showMore ? S(670) : S(450);
            return 0;
        }
        case WM_APP_LOG: AppendLog(); return 0;
        case WM_CTLCOLORSTATIC:
            if ((HWND)lp == g_hMeter) {  // green while nothing leaves the local network, red otherwise
                SetTextColor((HDC)wp, g_meterClean ? RGB(0x1E, 0x7B, 0x34) : RGB(0xC6, 0x28, 0x28));
                SetBkColor((HDC)wp, GetSysColor(COLOR_BTNFACE));
                return (LRESULT)GetSysColorBrush(COLOR_BTNFACE);
            }
            if ((HWND)lp == g_hHint) {  // grey hint line under the headline
                SetTextColor((HDC)wp, GetSysColor(COLOR_GRAYTEXT));
                SetBkColor((HDC)wp, GetSysColor(COLOR_BTNFACE));
                return (LRESULT)GetSysColorBrush(COLOR_BTNFACE);
            }
            break;
        case WM_TIMER: OnTimer(); return 0;
        case WM_HSCROLL:
            if ((HWND)lp == g_hDelay || (HWND)lp == g_hVol) OnSlider((HWND)lp);
            return 0;
        case WM_COMMAND:
            switch (LOWORD(wp)) {
                case CTL_START: OnStartStop(); break;
                case CTL_AUTO:
                    g_autoDone.clear();
                    if (AutoOn()) AutoTick();
                    break;
                case CTL_BT: OpenBluetoothSettings(); break;
                case CTL_PHONEOUT: ShowPanel(g_panelOut); break;
                case CTL_SCREEN:
                    SetWindowTextW(g_sStatus, L"Checking this PC...");
                    ShowWindow(g_panelScreen, SW_SHOW);
                    SetForegroundWindow(g_panelScreen);
                    UpdateWindow(g_panelScreen);
                    SetWindowTextW(g_sStatus, MiracastStatus().c_str());
                    break;
                case CTL_BTINFO: SendMessageW(g_panelIn, WM_COMMAND, CTL_P_INFO, 0); break;
                case CTL_VERIFY: {
                    wchar_t msg[2048];
                    swprintf(msg, 2048, kVerifyHelp, (unsigned)GetCurrentProcessId(), (unsigned)GetCurrentProcessId());
                    MessageBoxW(h, msg, L"SoundMesh - no internet, check it yourself", MB_ICONINFORMATION);
                    break;
                }
                case CTL_PHONEIN: ShowPanel(g_panelIn); break;
                case CTL_MORE: {
                    // Grow/shrink the window by the extra section instead of squeezing the list.
                    g_showMore = !g_showMore;
                    RECT r;
                    GetWindowRect(h, &r);
                    int extra = S(32) + S(32) + S(38) + S(20) + S(130);
                    if (!IsZoomed(h))
                        SetWindowPos(h, nullptr, 0, 0, r.right - r.left, r.bottom - r.top + (g_showMore ? extra : -extra),
                                     SWP_NOMOVE | SWP_NOZORDER);
                    Layout();
                    InvalidateRect(h, nullptr, TRUE);
                    break;
                }
                case CTL_HELP: MessageBoxW(h, kNetworkHelp, L"SoundMesh - network", MB_ICONINFORMATION); break;
                case CTL_REFRESH:
                    if (!g_engineOn) {
                        g_play = ListDevices(eRender);
                        g_rec = ListDevices(eCapture);
                        Populate();
                        Log("Devices refreshed: %zu playback, %zu recording.\n", g_play.size(), g_rec.size());
                    }
                    break;
            }
            return 0;
        case WM_NOTIFY: {
            NMHDR* nh = (NMHDR*)lp;
            if (nh->hwndFrom != g_hList) break;
            NMLISTVIEW* lv = (NMLISTVIEW*)lp;
            bool checkChange = (lv->uChanged & LVIF_STATE) && ((lv->uOldState ^ lv->uNewState) & LVIS_STATEIMAGEMASK);
            if (nh->code == LVN_ITEMCHANGED && lv->iItem >= 0 && lv->iItem < (int)g_play.size()) {
                if (checkChange && !g_populating) {
                    const int row = lv->iItem;
                    DevPref& p = g_prefs[g_play[row].id];
                    p.on = ListView_GetCheckState(g_hList, row) != 0;
                    if (g_engineOn) {  // ticking / unticking applies live
                        if (p.on) {
                            if (Output* o = AddOutput(g_play[row], row + 1)) {
                                o->delayMs = p.delay;
                                o->volPct = p.vol;
                            }
                        } else if (Output* o = OutputForRow(row)) o->enabled = false;
                        UpdateStatus();
                    }
                }
                if ((lv->uChanged & LVIF_STATE) && (lv->uNewState & LVIS_SELECTED) && !(lv->uOldState & LVIS_SELECTED)) {
                    g_selRow = lv->iItem;
                    UpdateSelControls();
                }
            }
            break;
        }
        case WM_CLOSE:
            SavePrefs();
            if (g_engineOn) Stop();
            g_engineOn = false;
            StopWeb();
            StopBtSink();
            DestroyWindow(h);
            return 0;
        case WM_DESTROY:
            g_logWnd = nullptr;
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

// Command-line options in the GUI build start playing right away and show
// the result in the window, so shortcuts like `soundmesh --to 2,3` work.
static void ApplyArgs(const Options& opt) {
    if (!Start(opt, g_play, g_rec)) {
        MessageBoxW(g_wnd, Wide(g_lastError).c_str(), L"SoundMesh", MB_ICONWARNING);
        return;
    }
    g_engineOn = true;
    g_populating = true;
    for (int i = 0; i < (int)g_play.size(); i++) ListView_SetCheckState(g_hList, i, FALSE);
    for (auto* o : Outputs()) {
        DevPref& p = g_prefs[o->dev.id];
        p.on = true;
        p.delay = o->delayMs;
        p.vol = o->volPct;
        for (int i = 0; i < (int)g_play.size(); i++)
            if (g_play[i].id == o->dev.id) {
                ListView_SetCheckState(g_hList, i, TRUE);
                RefreshRowSettings(i);
            }
    }
    g_populating = false;
    g_prefSrc = SrcItem{g_src.kind, (g_src.kind == SRC_NET || Lower(opt.from) == "loop") ? L"" : g_src.dev.id};
    for (size_t i = 0; i < g_srcItems.size(); i++)
        if (g_srcItems[i].kind == g_prefSrc.kind && g_srcItems[i].id == g_prefSrc.id) SendMessageW(g_hSource, CB_SETCURSEL, i, 0);
    if (g_net) {
        std::string n = opt.net;
        SetWindowTextW(g_hNet, Wide(n).c_str());
    }
    UpdateUi();
}

int main(int argc, char** argv) {
    InitializeCriticalSection(&g_logLock);
    InitializeCriticalSection(&g_outLock);
    InitializeCriticalSection(&g_bt.lock);
    OpenLogFile();
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    timeBeginPeriod(1);
    g_running = false;

    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_LISTVIEW_CLASSES | ICC_BAR_CLASSES | ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);
    HDC dc = GetDC(nullptr);
    g_dpi = GetDeviceCaps(dc, LOGPIXELSY);
    ReleaseDC(nullptr, dc);
    NONCLIENTMETRICSW ncm = {};
    ncm.cbSize = sizeof(ncm);
    SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0);
    g_font = CreateFontIndirectW(&ncm.lfMessageFont);
    LOGFONTW big = ncm.lfMessageFont;
    big.lfHeight = big.lfHeight * 3 / 2;
    big.lfWeight = FW_SEMIBOLD;
    g_bigFont = CreateFontIndirectW(&big);

    HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = L"SoundMeshWnd";
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
    if (!wc.hIcon) wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    wc.hIconSm = wc.hIcon;
    RegisterClassExW(&wc);
    WNDCLASSEXW pc = wc;
    pc.lpfnWndProc = PanelProc;
    pc.lpszClassName = L"SoundMeshPanel";
    RegisterClassExW(&pc);
    g_wnd = CreateWindowExW(0, wc.lpszClassName, L"SoundMesh", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
                            S(800), S(590), nullptr, nullptr, inst, nullptr);
    CreateControls();
    CreatePanels();
    g_logWnd = g_wnd;

    LoadPrefs();
    if (g_showMore) {  // window opens with the extra section already sized in
        RECT r;
        GetWindowRect(g_wnd, &r);
        SetWindowPos(g_wnd, nullptr, 0, 0, r.right - r.left, r.bottom - r.top + S(32) + S(32) + S(38) + S(20) + S(130),
                     SWP_NOMOVE | SWP_NOZORDER);
    }
    g_play = ListDevices(eRender);
    g_rec = ListDevices(eCapture);
    Populate();
    Layout();
    ShowWindow(g_wnd, SW_SHOWDEFAULT);
    SetTimer(g_wnd, kStatusTimer, 500, nullptr);

    Log("SoundMesh " SM_VERSION "\n"
        "Pair your headphones once in Bluetooth settings. With 'Auto-pick headphones' on, every\n"
        "headphone that is switched on gets the sound - also ones you switch on later.\n"
        "Click a device to change its delay (to line up lip sync) and volume - works live.\n"
        "Crackling? More options > Smooth mode.\n\n");
    if (SendMessageW(g_pWeb, BM_GETCHECK, 0, 0) == BST_CHECKED) SetPhonesListening(true);
    if (SendMessageW(g_pBt, BM_GETCHECK, 0, 0) == BST_CHECKED) SetPhoneIn(true);

    Options opt;
    std::string verb;
    if (!ParseArgs(argc, argv, opt, &verb)) MessageBoxW(g_wnd, Wide(g_lastError).c_str(), L"SoundMesh", MB_ICONWARNING);
    else if (verb == "bt") OpenBluetoothSettings();
    else if (argc > 1 && verb.empty()) {
        if (opt.phones) {
            g_phonePort = opt.phonePort;
            SetPhonesListening(true);
        }
        if (opt.phoneIn) SetPhoneIn(true);
        ApplyArgs(opt);
    }
    else if (AutoOn()) {
        Log("Auto mode: starting. Untick 'Auto-pick headphones' to choose devices yourself.\n");
        OnStartStop();
    }

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        if (IsDialogMessageW(GetAncestor(m.hwnd, GA_ROOT), &m)) continue;
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    timeEndPeriod(1);
    WSACleanup();
    CoUninitialize();
    return 0;
}

// ---------------------------------------------------------------- GUI ------
// Plain Win32 window on top of the same engine. Included by soundmesh.cpp
// when SM_CONSOLE is not defined. Settings persist in soundmesh.ini next to
// the exe, so the app stays portable.
#include <commctrl.h>
#include <map>

enum {
    CTL_SOURCE = 100, CTL_LIST, CTL_SEL, CTL_DELAY, CTL_DELAYTXT, CTL_VOL, CTL_VOLTXT,
    CTL_NET, CTL_LATENCY, CTL_SMOOTH, CTL_START, CTL_REFRESH, CTL_BT, CTL_HELP, CTL_LOG, CTL_LABEL
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
static HWND g_hNet, g_hLat, g_hSmooth, g_hStart, g_hRefresh, g_hBt, g_hHelp, g_hLog;
static HWND g_lSource, g_lOut, g_lNet, g_lLat, g_lLog;
static HFONT g_font;
static int g_dpi = 96;
static std::vector<DevInfo> g_play, g_rec;
static std::vector<SrcItem> g_srcItems;
static std::map<std::wstring, DevPref> g_prefs;
static SrcItem g_prefSrc{SRC_LOOPBACK, L""};
static bool g_engineOn = false, g_populating = false;
static int g_selRow = -1;

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
    for (auto* o : g_outputs)
        if (o->listIdx == row + 1) return o;
    return nullptr;
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
        if (!IsHandsFree(d.name)) add(L"What plays on: " + Wide(d.name), SrcItem{SRC_LOOPBACK, d.id});
    for (auto& d : g_rec) add(L"Microphone: " + Wide(d.name), SrcItem{SRC_MIC, d.id});
    add(L"Another PC on the network  (LAN stream)", SrcItem{SRC_NET, L""});
    int sel = 0;
    for (size_t i = 0; i < g_srcItems.size(); i++)
        if (g_srcItems[i].kind == g_prefSrc.kind && g_srcItems[i].id == g_prefSrc.id) sel = (int)i;
    SendMessageW(g_hSource, CB_SETCURSEL, sel, 0);

    SendMessageW(g_hList, LVM_DELETEALLITEMS, 0, 0);
    for (size_t i = 0; i < g_play.size(); i++) {
        std::wstring name = Wide(g_play[i].name);
        if (g_play[i].isDefault) name += L"   (Windows default)";
        if (IsHandsFree(g_play[i].name)) name += L"   (call mode, low quality - avoid)";
        LVITEMW it = {};
        it.mask = LVIF_TEXT;
        it.iItem = (int)i;
        it.pszText = (LPWSTR)name.c_str();
        SendMessageW(g_hList, LVM_INSERTITEMW, 0, (LPARAM)&it);
        ListView_SetCheckState(g_hList, (int)i, g_prefs[g_play[i].id].on);
        RefreshRowSettings((int)i);
    }
    g_selRow = -1;
    UpdateSelControls();
    g_populating = false;
}

static void UpdateUi() {
    SetWindowTextW(g_hStart, g_engineOn ? L"Stop" : L"Start");
    EnableWindow(g_hSource, !g_engineOn);
    EnableWindow(g_hNet, !g_engineOn);
    EnableWindow(g_hLat, !g_engineOn);
    EnableWindow(g_hSmooth, !g_engineOn);
    EnableWindow(g_hRefresh, !g_engineOn);
    if (!g_engineOn) {
        for (int i = 0; i < (int)g_play.size(); i++) SetCell(i, COL_STATUS, L"");
        SetWindowTextW(g_wnd, L"SoundMesh");
    }
}

static void OnTimer() {
    if (!g_engineOn) return;
    if (!g_running) {  // engine stopped itself (e.g. UDP port busy)
        Stop();
        g_engineOn = false;
        UpdateUi();
        return;
    }
    for (auto* o : g_outputs) {
        int row = o->listIdx - 1, st = o->state;
        wchar_t b[96];
        if (st == OS_PLAYING) swprintf(b, 96, L"playing  %d ms", (o->fillMs + 5) / 10 * 10);
        else if (st == OS_CONNECTING && g_src.kind == SRC_NET && !g_srcFrames) swprintf(b, 96, L"waiting for LAN");
        else swprintf(b, 96, L"%hs", kStateName[st]);
        uint32_t u = o->underruns;
        if (u) swprintf(b + wcslen(b), 96 - wcslen(b), L"  (%u gaps)", u);
        SetCell(row, COL_STATUS, b);
    }
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
}

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

static void Layout() {
    RECT rc;
    GetClientRect(g_wnd, &rc);
    const int W = rc.right, H = rc.bottom, m = S(10), lineH = S(24), labelW = S(85);
    int y = m;

    Place(g_lSource, m, y + S(4), labelW, S(18));
    Place(g_hSource, m + labelW, y, W - 2 * m - labelW, S(300));
    y += S(34);
    Place(g_lOut, m, y, W - 2 * m, S(18));
    y += S(20);

    const int fixed = S(34) + S(32) + S(38) + S(24) + m;
    const int avail = std::max(S(160), H - y - fixed);
    const int listH = std::max(S(90), avail * 55 / 100), logH = std::max(S(60), avail - listH);

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

    int latW = S(55), latLabelW = S(80);
    Place(g_lNet, m, y + S(4), labelW, S(18));
    Place(g_hNet, m + labelW, y, W - 2 * m - labelW - latLabelW - latW - S(10), lineH);
    Place(g_lLat, W - m - latW - latLabelW, y + S(4), latLabelW, S(18));
    Place(g_hLat, W - m - latW, y, latW, lineH);
    y += S(32);

    int bx = m, bh = S(30);
    Place(g_hStart, bx, y, S(110), bh);
    bx += S(118);
    Place(g_hRefresh, bx, y, S(130), bh);
    bx += S(138);
    Place(g_hBt, bx, y, S(150), bh);
    bx += S(158);
    Place(g_hHelp, bx, y, S(130), bh);
    Place(g_hSmooth, W - m - S(170), y + S(5), S(170), S(20));
    y += S(38);

    Place(g_lLog, m, y, W - 2 * m, S(18));
    y += S(20);
    Place(g_hLog, m, y, W - 2 * m, std::max(S(40), H - y - m));
    (void)logH;
}

static HWND Mk(const wchar_t* cls, const wchar_t* text, DWORD style, int id, DWORD ex = 0) {
    HWND h = CreateWindowExW(ex, cls, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 10, 10, g_wnd, (HMENU)(INT_PTR)id,
                             GetModuleHandleW(nullptr), nullptr);
    SendMessageW(h, WM_SETFONT, (WPARAM)g_font, TRUE);
    return h;
}

static void CreateControls() {
    g_lSource = Mk(L"STATIC", L"Source:", 0, CTL_LABEL);
    g_hSource = Mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, CTL_SOURCE);
    g_lOut = Mk(L"STATIC", L"Play on - tick every headphone / speaker that should get the sound:", 0, CTL_LABEL);

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

    g_lNet = Mk(L"STATIC", L"Send to LAN:", 0, CTL_LABEL);
    g_hNet = Mk(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, CTL_NET, WS_EX_CLIENTEDGE);
    SendMessageW(g_hNet, EM_SETCUEBANNER, TRUE, (LPARAM)L"off  -  or IPs like 192.168.1.23, 192.168.1.40  -  or multicast");
    g_lLat = Mk(L"STATIC", L"Latency ms:", 0, CTL_LABEL);
    g_hLat = Mk(L"EDIT", L"", ES_AUTOHSCROLL | ES_NUMBER | WS_TABSTOP, CTL_LATENCY, WS_EX_CLIENTEDGE);
    SendMessageW(g_hLat, EM_SETCUEBANNER, TRUE, (LPARAM)L"auto");

    g_hStart = Mk(L"BUTTON", L"Start", BS_DEFPUSHBUTTON | WS_TABSTOP, CTL_START);
    g_hRefresh = Mk(L"BUTTON", L"Refresh devices", WS_TABSTOP, CTL_REFRESH);
    g_hBt = Mk(L"BUTTON", L"Bluetooth settings...", WS_TABSTOP, CTL_BT);
    g_hHelp = Mk(L"BUTTON", L"Network help...", WS_TABSTOP, CTL_HELP);
    g_hSmooth = Mk(L"BUTTON", L"Smooth mode (+70 ms)", BS_AUTOCHECKBOX | WS_TABSTOP, CTL_SMOOTH);

    g_lLog = Mk(L"STATIC", L"Log:", 0, CTL_LABEL);
    g_hLog = Mk(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, CTL_LOG, WS_EX_CLIENTEDGE);
}

// -------------------------------------------------------------- window -----
static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE: Layout(); return 0;
        case WM_GETMINMAXINFO: {
            MINMAXINFO* mm = (MINMAXINFO*)lp;
            mm->ptMinTrackSize.x = S(760);
            mm->ptMinTrackSize.y = S(500);
            return 0;
        }
        case WM_APP_LOG: AppendLog(); return 0;
        case WM_TIMER: OnTimer(); return 0;
        case WM_HSCROLL:
            if ((HWND)lp == g_hDelay || (HWND)lp == g_hVol) OnSlider((HWND)lp);
            return 0;
        case WM_COMMAND:
            switch (LOWORD(wp)) {
                case CTL_START: OnStartStop(); break;
                case CTL_BT: OpenBluetoothSettings(); break;
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
            if (nh->code == LVN_ITEMCHANGING && checkChange && g_engineOn && !g_populating) {
                MessageBeep(MB_OK);  // outputs are fixed while running: Stop, tick, Start
                return TRUE;
            }
            if (nh->code == LVN_ITEMCHANGED && lv->iItem >= 0 && lv->iItem < (int)g_play.size()) {
                if (checkChange && !g_populating) g_prefs[g_play[lv->iItem].id].on = ListView_GetCheckState(g_hList, lv->iItem) != 0;
                if ((lv->uChanged & LVIF_STATE) && (lv->uNewState & LVIS_SELECTED) && !(lv->uOldState & LVIS_SELECTED)) {
                    g_selRow = lv->iItem;
                    UpdateSelControls();
                }
            }
            break;
        }
        case WM_CLOSE:
            if (g_engineOn) Stop();
            g_engineOn = false;
            SavePrefs();
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
    for (auto* o : g_outputs) {
        DevPref& p = g_prefs[o->dev.id];
        p.on = true;
        p.delay = o->delayMs;
        p.vol = o->volPct;
        ListView_SetCheckState(g_hList, o->listIdx - 1, TRUE);
        RefreshRowSettings(o->listIdx - 1);
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
    g_wnd = CreateWindowExW(0, wc.lpszClassName, L"SoundMesh", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
                            S(800), S(640), nullptr, nullptr, inst, nullptr);
    CreateControls();
    g_logWnd = g_wnd;

    LoadPrefs();
    g_play = ListDevices(eRender);
    g_rec = ListDevices(eCapture);
    Populate();
    Layout();
    ShowWindow(g_wnd, SW_SHOWDEFAULT);
    SetTimer(g_wnd, kStatusTimer, 500, nullptr);

    Log("SoundMesh " SM_VERSION "\n"
        "1. Pair your headphones in Bluetooth settings and switch them on (then 'Refresh devices').\n"
        "2. Source: usually 'What this PC plays'.\n"
        "3. Tick the headphones/speakers to play on and press Start.\n"
        "Click a device to change its delay (to line up lip sync) and volume - works live.\n"
        "Crackling? Stop, tick 'Smooth mode', Start.\n\n");

    Options opt;
    std::string verb;
    if (!ParseArgs(argc, argv, opt, &verb)) MessageBoxW(g_wnd, Wide(g_lastError).c_str(), L"SoundMesh", MB_ICONWARNING);
    else if (verb == "bt") OpenBluetoothSettings();
    else if (argc > 1 && verb.empty()) ApplyArgs(opt);

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        if (IsDialogMessageW(g_wnd, &m)) continue;
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    timeEndPeriod(1);
    WSACleanup();
    CoUninitialize();
    return 0;
}

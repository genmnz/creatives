// ------------------------------------------------ phones (Bluetooth in) ----
// Makes this PC a Bluetooth speaker for paired phones (Windows 10 2004+ and
// Windows 11, Windows.Media.Audio.AudioPlaybackConnection). The phone's sound
// then plays on the PC's default output, and SoundMesh's loopback fans it out
// to every headphone.
//
// Called through the raw WinRT ABI (vtable slots and IIDs from the Windows
// metadata, as published in microsoft/windows-rs), with combase loaded at
// runtime, so the exe still starts on Windows versions without this API.
// Async calls are completed by polling IAsyncInfo, which avoids implementing
// WinRT delegates.

typedef void* WrtStr;  // HSTRING
typedef HRESULT(WINAPI* PFN_RoInitialize)(int);
typedef HRESULT(WINAPI* PFN_RoGetActivationFactory)(WrtStr, REFIID, void**);
typedef HRESULT(WINAPI* PFN_WindowsCreateString)(LPCWSTR, UINT32, WrtStr*);
typedef HRESULT(WINAPI* PFN_WindowsDeleteString)(WrtStr);
typedef PCWSTR(WINAPI* PFN_WindowsGetStringRawBuffer)(WrtStr, UINT32*);

static const IID kIID_IAudioPlaybackConnectionStatics = {0xE60963A2, 0x69E6, 0x5FFC, {0x9E, 0x13, 0x82, 0x4A, 0x85, 0x21, 0x3D, 0xAF}};
static const IID kIID_IDeviceInformationStatics = {0xC17F100E, 0x3A46, 0x4A78, {0x80, 0x13, 0x76, 0x9D, 0xC9, 0xB9, 0x73, 0x90}};
static const IID kIID_IAsyncInfo = {0x00000036, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

// Vtable slots (0-2 IUnknown, 3-5 IInspectable).
enum {
    kSlotRelease = 2,
    kStatics_GetDeviceSelector = 6, kStatics_TryCreateFromId = 7,
    kConn_Start = 6, kConn_State = 9, kConn_Open = 10,
    kOpenResult_Status = 6, kOpenResult_ExtendedError = 7,
    kDevStatics_FindAllAsyncAqsFilter = 10,
    kAsyncOp_GetResults = 8,
    kAsyncInfo_Status = 7, kAsyncInfo_ErrorCode = 8,
    kVector_GetAt = 6, kVector_Size = 7,
    kDevInfo_Id = 6, kDevInfo_Name = 7,
};

template <class F> static F Slot(void* obj, int i) { return (F)((*(void***)obj)[i]); }
static void WrtRelease(void*& p) {
    if (p) { Slot<ULONG(STDMETHODCALLTYPE*)(void*)>(p, kSlotRelease)(p); p = nullptr; }
}
static HRESULT CallOut(void* obj, int slot, void** out) { return Slot<HRESULT(STDMETHODCALLTYPE*)(void*, void**)>(obj, slot)(obj, out); }

struct PhoneIn {
    std::wstring id;
    std::string name;
    void* conn = nullptr;   // IAudioPlaybackConnection, kept alive while enabled
    std::atomic<int> state{0};  // 0 ready (phone may connect), 1 connected
};

static struct {
    HMODULE combase = nullptr;
    PFN_RoGetActivationFactory getFactory = nullptr;
    PFN_RoInitialize roInit = nullptr;
    PFN_WindowsCreateString mkStr = nullptr;
    PFN_WindowsDeleteString delStr = nullptr;
    PFN_WindowsGetStringRawBuffer rawStr = nullptr;
    std::atomic<bool> on{false};
    std::atomic<bool> supported{true};
    HANDLE thread = nullptr;
    CRITICAL_SECTION lock;          // guards phones (names/ids read by the UI)
    std::vector<PhoneIn*> phones;
    std::wstring connectId;         // UI asks to connect this one (under lock)
} g_bt;

static std::string FromHString(WrtStr h) {
    if (!h) return std::string();
    UINT32 n = 0;
    PCWSTR p = g_bt.rawStr(h, &n);
    return Utf8(std::wstring(p, n));
}

static bool WrtLoad() {
    if (g_bt.combase) return g_bt.getFactory != nullptr;
    g_bt.combase = LoadLibraryW(L"combase.dll");
    if (!g_bt.combase) return false;
    g_bt.getFactory = (PFN_RoGetActivationFactory)GetProcAddress(g_bt.combase, "RoGetActivationFactory");
    g_bt.roInit = (PFN_RoInitialize)GetProcAddress(g_bt.combase, "RoInitialize");
    g_bt.mkStr = (PFN_WindowsCreateString)GetProcAddress(g_bt.combase, "WindowsCreateString");
    g_bt.delStr = (PFN_WindowsDeleteString)GetProcAddress(g_bt.combase, "WindowsDeleteString");
    g_bt.rawStr = (PFN_WindowsGetStringRawBuffer)GetProcAddress(g_bt.combase, "WindowsGetStringRawBuffer");
    return g_bt.getFactory && g_bt.roInit && g_bt.mkStr && g_bt.delStr && g_bt.rawStr;
}

static void* WrtFactory(const wchar_t* cls, const IID& iid) {
    WrtStr h = nullptr;
    void* f = nullptr;
    if (SUCCEEDED(g_bt.mkStr(cls, (UINT32)wcslen(cls), &h))) {
        g_bt.getFactory(h, iid, &f);
        g_bt.delStr(h);
    }
    return f;
}

// Wait for an IAsyncOperation / IAsyncAction to finish (polling, max ~10 s).
static bool WrtWait(void* op) {
    void* info = nullptr;
    if (FAILED(Slot<HRESULT(STDMETHODCALLTYPE*)(void*, const IID&, void**)>(op, 0)(op, kIID_IAsyncInfo, &info))) return false;
    int status = 0;  // 0 started, 1 completed, 2 canceled, 3 error
    for (int i = 0; i < 1000 && g_bt.on; i++) {
        if (FAILED(Slot<HRESULT(STDMETHODCALLTYPE*)(void*, int*)>(info, kAsyncInfo_Status)(info, &status)) || status != 0) break;
        Sleep(10);
    }
    WrtRelease(info);
    return status == 1;
}

static DWORD WINAPI BtSinkThread(LPVOID) {
    g_bt.roInit(1);  // RO_INIT_MULTITHREADED
    void* statics = WrtFactory(L"Windows.Media.Audio.AudioPlaybackConnection", kIID_IAudioPlaybackConnectionStatics);
    void* devStatics = WrtFactory(L"Windows.Devices.Enumeration.DeviceInformation", kIID_IDeviceInformationStatics);
    WrtStr selector = nullptr;
    if (!statics || !devStatics || FAILED(CallOut(statics, kStatics_GetDeviceSelector, (void**)&selector))) {
        Log("! This Windows can't act as a Bluetooth speaker (needs Windows 10 version 2004 or newer, or Windows 11).\n");
        g_bt.supported = false;
        g_bt.on = false;
        WrtRelease(statics);
        WrtRelease(devStatics);
        CoUninitialize();
        return 0;
    }
    Log("  Bluetooth receiver on: on your phone, open Bluetooth and connect to this PC.\n");

    for (int round = 0; g_bt.on; round++) {
        // Every ~3 s: pick up newly paired phones and enable them.
        if (round % 30 == 0) {
            void* op = nullptr;
            void* list = nullptr;
            auto findAll = Slot<HRESULT(STDMETHODCALLTYPE*)(void*, WrtStr, void**)>(devStatics, kDevStatics_FindAllAsyncAqsFilter);
            if (SUCCEEDED(findAll(devStatics, selector, &op)) && WrtWait(op)) CallOut(op, kAsyncOp_GetResults, &list);
            WrtRelease(op);
            UINT32 n = 0;
            if (list) Slot<HRESULT(STDMETHODCALLTYPE*)(void*, UINT32*)>(list, kVector_Size)(list, &n);
            for (UINT32 i = 0; i < n; i++) {
                void* dev = nullptr;
                if (FAILED(Slot<HRESULT(STDMETHODCALLTYPE*)(void*, UINT32, void**)>(list, kVector_GetAt)(list, i, &dev))) continue;
                WrtStr hid = nullptr, hname = nullptr;
                CallOut(dev, kDevInfo_Id, (void**)&hid);
                CallOut(dev, kDevInfo_Name, (void**)&hname);
                std::wstring id = Wide8(FromHString(hid));
                bool known = false;
                EnterCriticalSection(&g_bt.lock);
                for (auto* p : g_bt.phones) known |= p->id == id;
                LeaveCriticalSection(&g_bt.lock);
                if (!known) {
                    void* conn = nullptr;
                    auto tryCreate = Slot<HRESULT(STDMETHODCALLTYPE*)(void*, WrtStr, void**)>(statics, kStatics_TryCreateFromId);
                    if (SUCCEEDED(tryCreate(statics, hid, &conn)) && conn &&
                        SUCCEEDED(Slot<HRESULT(STDMETHODCALLTYPE*)(void*)>(conn, kConn_Start)(conn))) {
                        PhoneIn* p = new PhoneIn();
                        p->id = id;
                        p->name = FromHString(hname);
                        p->conn = conn;
                        EnterCriticalSection(&g_bt.lock);
                        g_bt.phones.push_back(p);
                        LeaveCriticalSection(&g_bt.lock);
                        Log("  phone ready: %s\n", p->name.c_str());
                    } else WrtRelease(conn);
                }
                if (hid) g_bt.delStr(hid);
                if (hname) g_bt.delStr(hname);
                WrtRelease(dev);
            }
            WrtRelease(list);
        }

        // Connection state, and connect requests from the UI.
        std::wstring want;
        EnterCriticalSection(&g_bt.lock);
        want.swap(g_bt.connectId);
        std::vector<PhoneIn*> phones = g_bt.phones;
        LeaveCriticalSection(&g_bt.lock);
        for (auto* p : phones) {
            int st = 0;
            Slot<HRESULT(STDMETHODCALLTYPE*)(void*, int*)>(p->conn, kConn_State)(p->conn, &st);
            if (st != p->state) Log("  %s %s\n", p->name.c_str(), st ? "connected - its sound now plays here" : "disconnected");
            p->state = st;
            if (p->id == want && !st) {
                Log("  connecting to %s...\n", p->name.c_str());
                void* res = nullptr;
                int status = 3;
                HRESULT ext = S_OK;
                HRESULT hr = CallOut(p->conn, kConn_Open, &res);
                if (SUCCEEDED(hr) && res) {
                    Slot<HRESULT(STDMETHODCALLTYPE*)(void*, int*)>(res, kOpenResult_Status)(res, &status);
                    Slot<HRESULT(STDMETHODCALLTYPE*)(void*, HRESULT*)>(res, kOpenResult_ExtendedError)(res, &ext);
                } else ext = hr;
                WrtRelease(res);
                static const char* why[] = {"ok", "the phone did not answer (timed out)", "Windows refused", "failed"};
                if (status)
                    Log("! could not connect to %s: %s (code 0x%08lx). Forget the PC on the phone and pair again with this "
                        "receiver on - see the tips in this window.\n",
                        p->name.c_str(), why[std::max(0, std::min(3, status))], (unsigned long)ext);
            }
        }
        Sleep(100);
    }

    EnterCriticalSection(&g_bt.lock);
    for (auto* p : g_bt.phones) {
        WrtRelease(p->conn);  // closes the connection
        delete p;
    }
    g_bt.phones.clear();
    LeaveCriticalSection(&g_bt.lock);
    g_bt.delStr(selector);
    WrtRelease(statics);
    WrtRelease(devStatics);
    CoUninitialize();
    return 0;
}

static bool StartBtSink() {
    if (g_bt.on) return true;
    if (!WrtLoad()) {
        Log("! This Windows can't act as a Bluetooth speaker (WinRT not available).\n");
        g_bt.supported = false;
        return false;
    }
    g_bt.on = true;
    g_bt.thread = CreateThread(nullptr, 0, BtSinkThread, nullptr, 0, nullptr);
    return true;
}

static void StopBtSink() {
    if (!g_bt.thread) return;
    bool wasOn = g_bt.on;
    g_bt.on = false;
    WaitForSingleObject(g_bt.thread, 15000);
    CloseHandle(g_bt.thread);
    g_bt.thread = nullptr;
    if (wasOn) Log("  Bluetooth receiver off.\n");
}

[[maybe_unused]] static void BtConnect(const std::wstring& id) {
    EnterCriticalSection(&g_bt.lock);
    g_bt.connectId = id;
    LeaveCriticalSection(&g_bt.lock);
}

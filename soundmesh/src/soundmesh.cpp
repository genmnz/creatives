// SoundMesh - route one audio source to many outputs at once on Windows.
//
//   * Sources: loopback of any playback device (what you hear), any microphone,
//     or a LAN stream (Scream protocol).
//   * Outputs: any number of playback devices (several Bluetooth headphones,
//     USB, HDMI, speakers) plus the LAN (multicast or unicast, Scream protocol).
//
// Plain user-mode WASAPI + Winsock. No driver, no installer, no internet.
// Each output has its own ring buffer and a small adaptive resampler that
// keeps it locked to the source clock, plus a per-output delay for lip sync.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <shellapi.h>
#include <mmsystem.h>
#include <iphlpapi.h>

#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

#define SM_VERSION "1.5.0"

// ---------------------------------------------------------------- GUIDs ----
// Defined locally so the build does not depend on which uuid libs the
// toolchain ships.
static const CLSID kCLSID_MMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
static const IID kIID_IMMDeviceEnumerator = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
static const IID kIID_IAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const IID kIID_IAudioRenderClient = {0xF294ACFC, 0x3146, 0x4483, {0xA7, 0xBF, 0xAD, 0xDC, 0xA7, 0xC2, 0x60, 0xE2}};
static const IID kIID_IAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const GUID kSubtypeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
static const GUID kSubtypePcm = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
static const PROPERTYKEY kPKEY_FriendlyName = {{0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 14};
static const PROPERTYKEY kPKEY_EnumeratorName = {{0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 24};
static const PROPERTYKEY kPKEY_FormFactor = {{0x1DA5D803, 0xD492, 0x4EDD, {0x8C, 0x23, 0xE0, 0xC0, 0xFF, 0xEE, 0x7F, 0x0E}}, 0};

template <class T> static void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// -------------------------------------------------------------- logging ----
// Console build prints; the GUI build sets g_logWnd and gets WM_APP_LOG
// whenever g_logQueue has new text (audio threads never touch windows).
#define WM_APP_LOG (WM_APP + 1)
static CRITICAL_SECTION g_logLock;
static HWND g_logWnd = nullptr;
static std::string g_logQueue;
static std::string g_lastError;

static void LogV(const char* fmt, va_list ap) {
    char buf[1024];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    EnterCriticalSection(&g_logLock);
    if (buf[0] == '!') g_lastError = buf + 2;
    if (g_logWnd) {
        g_logQueue += buf;
        PostMessageW(g_logWnd, WM_APP_LOG, 0, 0);
    } else {
        fputs(buf, stdout);
        fflush(stdout);
    }
    LeaveCriticalSection(&g_logLock);
}

static void Log(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    LogV(fmt, ap);
    va_end(ap);
}

static std::string Utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::wstring Wide8(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

static std::string Lower(std::string s) {
    for (auto& c : s) c = (char)tolower((unsigned char)c);
    return s;
}

// -------------------------------------------------------------- globals ----
static std::atomic<bool> g_running{true};
static std::atomic<uint32_t> g_rate{48000};      // internal sample rate (Hz), stereo float
static std::atomic<int> g_baseLatencyMs{60};    // buffering every output keeps before playing
static std::atomic<int> g_deviceBufferMs{30};   // WASAPI buffer per output; larger = fewer crackles, more lag

// ----------------------------------------------------------- devices -------
struct DevInfo {
    std::wstring id;
    std::string name;
    bool isDefault = false;
    std::string bus;      // "BTHENUM" (Bluetooth), "BTHHFENUM" (Bluetooth call mode), "USB", "HDAUDIO", ...
    int formFactor = -1;  // EndpointFormFactor: 1 speakers, 3 headphones, 5 headset, ...
};

static IMMDeviceEnumerator* NewEnumerator() {
    IMMDeviceEnumerator* e = nullptr;
    CoCreateInstance(kCLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, kIID_IMMDeviceEnumerator, (void**)&e);
    return e;
}

static std::vector<DevInfo> ListDevices(EDataFlow flow) {
    std::vector<DevInfo> out;
    IMMDeviceEnumerator* en = NewEnumerator();
    if (!en) return out;
    std::wstring defId;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eConsole, &def))) {
        LPWSTR id = nullptr;
        if (SUCCEEDED(def->GetId(&id))) { defId = id; CoTaskMemFree(id); }
        SafeRelease(def);
    }
    IMMDeviceCollection* col = nullptr;
    if (SUCCEEDED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col))) {
        UINT n = 0;
        col->GetCount(&n);
        for (UINT i = 0; i < n; i++) {
            IMMDevice* d = nullptr;
            if (FAILED(col->Item(i, &d))) continue;
            DevInfo info;
            LPWSTR id = nullptr;
            if (SUCCEEDED(d->GetId(&id))) { info.id = id; CoTaskMemFree(id); }
            IPropertyStore* ps = nullptr;
            if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps))) {
                PROPVARIANT v;
                PropVariantInit(&v);
                if (SUCCEEDED(ps->GetValue(kPKEY_FriendlyName, &v)) && v.vt == VT_LPWSTR) info.name = Utf8(v.pwszVal);
                PropVariantClear(&v);
                if (SUCCEEDED(ps->GetValue(kPKEY_EnumeratorName, &v)) && v.vt == VT_LPWSTR) info.bus = Utf8(v.pwszVal);
                PropVariantClear(&v);
                if (SUCCEEDED(ps->GetValue(kPKEY_FormFactor, &v)) && v.vt == VT_UI4) info.formFactor = (int)v.ulVal;
                PropVariantClear(&v);
                SafeRelease(ps);
            }
            info.isDefault = (info.id == defId);
            out.push_back(info);
            SafeRelease(d);
        }
        SafeRelease(col);
    }
    SafeRelease(en);
    return out;
}

static bool IsHandsFree(const DevInfo& d) {
    std::string l = Lower(d.name), bus = Lower(d.bus);
    return l.find("hands-free") != std::string::npos || l.find("handsfree") != std::string::npos ||
           bus.find("bthhf") != std::string::npos;
}

static bool IsBluetooth(const DevInfo& d) { return Lower(d.bus).find("bth") != std::string::npos; }

// What "auto" picks: Bluetooth headphones/speakers in music (A2DP) mode, and
// anything Windows itself reports as headphones or a headset (USB, jack).
static bool IsAutoHeadphone(const DevInfo& d) {
    if (IsHandsFree(d)) return false;
    if (IsBluetooth(d) || d.formFactor == 3 || d.formFactor == 5) return true;
    // Fallback when a driver leaves the properties empty: Windows names these
    // endpoints "Headphones (...)" / "Headset (...)".
    std::string l = Lower(d.name);
    for (const char* k : {"headphone", "headset", "earphone", "earbud", "airpods", "buds"})
        if (l.find(k) != std::string::npos) return true;
    return false;
}

static std::wstring DefaultRenderId() {
    std::wstring id;
    IMMDeviceEnumerator* en = NewEnumerator();
    IMMDevice* d = nullptr;
    if (en && SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &d))) {
        LPWSTR s = nullptr;
        if (SUCCEEDED(d->GetId(&s))) { id = s; CoTaskMemFree(s); }
    }
    SafeRelease(d);
    SafeRelease(en);
    return id;
}

static IAudioClient* ActivateClient(const std::wstring& id) {
    IMMDeviceEnumerator* en = NewEnumerator();
    if (!en) return nullptr;
    IMMDevice* d = nullptr;
    IAudioClient* c = nullptr;
    if (SUCCEEDED(en->GetDevice(id.c_str(), &d))) d->Activate(kIID_IAudioClient, CLSCTX_ALL, nullptr, (void**)&c);
    SafeRelease(d);
    SafeRelease(en);
    return c;
}

// --------------------------------------------------------- sample format ---
struct Fmt {
    uint32_t rate = 48000, channels = 2, bits = 32;
    bool isFloat = true;
};

static bool ParseFormat(const WAVEFORMATEX* wf, Fmt& f) {
    f.rate = wf->nSamplesPerSec;
    f.channels = wf->nChannels;
    f.bits = wf->wBitsPerSample;
    if (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) f.isFloat = true;
    else if (wf->wFormatTag == WAVE_FORMAT_PCM) f.isFloat = false;
    else if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        const WAVEFORMATEXTENSIBLE* x = (const WAVEFORMATEXTENSIBLE*)wf;
        if (IsEqualGUID(x->SubFormat, kSubtypeFloat)) f.isFloat = true;
        else if (IsEqualGUID(x->SubFormat, kSubtypePcm)) f.isFloat = false;
        else return false;
        if (x->Samples.wValidBitsPerSample && !f.isFloat && f.bits == 32) f.bits = 32;  // 24-in-32 reads fine as 32
    } else return false;
    if (f.isFloat && f.bits != 32) return false;
    if (!f.isFloat && f.bits != 16 && f.bits != 24 && f.bits != 32) return false;
    return f.channels >= 1;
}

static inline float ReadSample(const uint8_t* p, const Fmt& f) {
    if (f.isFloat) { float v; memcpy(&v, p, 4); return v; }
    switch (f.bits) {
        case 16: { int16_t v; memcpy(&v, p, 2); return v * (1.0f / 32768.0f); }
        case 24: { int32_t v = (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24); return v * (1.0f / 2147483648.0f); }
        default: { int32_t v; memcpy(&v, p, 4); return v * (1.0f / 2147483648.0f); }
    }
}

// Convert any interleaved PCM to interleaved stereo float. Extra channels
// beyond front L/R are dropped; mono is duplicated to both ears.
static void ToStereo(const uint8_t* src, uint32_t frames, const Fmt& f, float* dst) {
    const uint32_t bps = f.bits / 8, stride = bps * f.channels;
    for (uint32_t i = 0; i < frames; i++) {
        const uint8_t* p = src + (size_t)i * stride;
        float l = ReadSample(p, f);
        float r = f.channels > 1 ? ReadSample(p + bps, f) : l;
        dst[2 * i] = l;
        dst[2 * i + 1] = r;
    }
}

// -------------------------------------------------------------- ring -------
// Single-producer / single-consumer ring of stereo float frames.
struct Ring {
    static const uint64_t kFrames = 1u << 17;  // ~2.7 s at 48 kHz
    static const uint64_t kMask = kFrames - 1;
    float* buf = nullptr;
    std::atomic<uint64_t> w{0}, r{0};
    Ring() { buf = (float*)calloc(kFrames * 2, sizeof(float)); }
    ~Ring() { free(buf); }
    void Push(const float* s, uint32_t n) {
        uint64_t W = w.load(std::memory_order_relaxed), R = r.load(std::memory_order_acquire);
        uint64_t space = kFrames - (W - R);
        if (n > space) n = (uint32_t)space;  // reader stalled (device gone): drop newest
        for (uint32_t i = 0; i < n; i++) {
            uint64_t k = ((W + i) & kMask) * 2;
            buf[k] = s[2 * i];
            buf[k + 1] = s[2 * i + 1];
        }
        w.store(W + n, std::memory_order_release);
    }
};

// ------------------------------------------------------------ outputs ------
enum OutState { OS_CONNECTING, OS_BUFFERING, OS_PLAYING, OS_LOST, OS_OFF, OS_DIRECT };
static const char* kStateName[] = {"connecting", "buffering", "playing", "reconnecting", "off", "plays directly"};

struct Output {
    int listIdx = 0;  // number shown by `list`
    DevInfo dev;
    Ring ring;
    std::atomic<int> delayMs{0};
    std::atomic<int> volPct{100};
    std::atomic<int> state{OS_CONNECTING};
    std::atomic<int> fillMs{0};
    std::atomic<uint32_t> underruns{0};
    std::atomic<bool> enabled{true};   // unticked while running -> device released
    std::atomic<bool> isSource{false}; // it is the device being captured: playing to it would echo
    HANDLE thread = nullptr;
};

// Fixed slots so outputs can be added while the capture thread iterates
// them: a slot is filled before the count is published, and never moves.
static const int kMaxOutputs = 32;
static Output* g_outs[kMaxOutputs];
static std::atomic<int> g_nOuts{0};
static CRITICAL_SECTION g_outLock;  // serialises adding vs. starting output threads
static bool g_outputsLive = false;  // output threads are running (sample rate known)

struct OutRange {
    Output** b;
    Output** e;
    Output** begin() const { return b; }
    Output** end() const { return e; }
};
static OutRange Outputs() { return OutRange{g_outs, g_outs + g_nOuts.load(std::memory_order_acquire)}; }

static DWORD WINAPI OutputThread(LPVOID arg) {
    Output* o = (Output*)arg;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    bool announced = false;

    while (g_running) {
        if (!o->enabled || o->isSource) {
            o->state = o->enabled ? OS_DIRECT : OS_OFF;
            Sleep(100);
            continue;
        }
        const uint32_t rate = g_rate;
        IAudioClient* ac = ActivateClient(o->dev.id);
        IAudioRenderClient* rc = nullptr;
        bool useEvent = true;
        UINT32 bufFrames = 0;
        HRESULT hr = E_FAIL;

        if (ac) {
            // Ask for stereo float at the source rate; the Windows audio engine
            // converts to whatever the device (e.g. a Bluetooth A2DP sink) wants.
            WAVEFORMATEXTENSIBLE wf = {};
            wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
            wf.Format.nChannels = 2;
            wf.Format.nSamplesPerSec = rate;
            wf.Format.wBitsPerSample = 32;
            wf.Format.nBlockAlign = 8;
            wf.Format.nAvgBytesPerSec = rate * 8;
            wf.Format.cbSize = sizeof(wf) - sizeof(WAVEFORMATEX);
            wf.Samples.wValidBitsPerSample = 32;
            wf.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
            wf.SubFormat = kSubtypeFloat;
            const DWORD conv = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            const REFERENCE_TIME bufHns = (REFERENCE_TIME)g_deviceBufferMs * 10000;
            hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | conv, bufHns, 0, (WAVEFORMATEX*)&wf, nullptr);
            if (FAILED(hr)) {
                // Some older drivers refuse event mode together with conversion.
                SafeRelease(ac);
                ac = ActivateClient(o->dev.id);
                useEvent = false;
                if (ac) hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, conv, bufHns * 2, 0, (WAVEFORMATEX*)&wf, nullptr);
            }
            if (SUCCEEDED(hr)) hr = ac->GetBufferSize(&bufFrames);
            if (SUCCEEDED(hr)) hr = ac->GetService(kIID_IAudioRenderClient, (void**)&rc);
            if (SUCCEEDED(hr) && useEvent) hr = ac->SetEventHandle(ev);
            if (SUCCEEDED(hr)) hr = ac->Start();
        }

        if (FAILED(hr) || !ac) {
            if (!announced) Log("  [%d] %s: cannot open (0x%08lx), retrying...\n", o->listIdx, o->dev.name.c_str(), (unsigned long)hr);
            announced = true;
            o->state = OS_LOST;
            SafeRelease(rc);
            SafeRelease(ac);
            for (int i = 0; i < 20 && g_running; i++) Sleep(100);
            continue;
        }
        Log("  [%d] %s: connected\n", o->listIdx, o->dev.name.c_str());
        announced = false;

        // Start fresh: drop anything that piled up while we were away.
        o->ring.r.store(o->ring.w.load(std::memory_order_acquire), std::memory_order_release);
        o->state = OS_BUFFERING;
        double frac = 0.0, ema = 0.0;
        const int kRamp = 256;  // ~5 ms fade-in after every start/jump: no pops
        int ramp = 0;
        // Devices start with a burst of their own latency; for the first 3 s
        // snap to the target instead of drifting there slowly, so outputs
        // that joined at different moments still line up.
        int64_t settle = 3 * (int64_t)rate;
        int64_t highFor = 0;  // frames the buffer has stayed well above target
        uint64_t R = o->ring.r.load(std::memory_order_relaxed);
        const float* rb = o->ring.buf;

        while (g_running && o->enabled && !o->isSource) {
            if (useEvent) WaitForSingleObject(ev, 50);
            else Sleep(5);
            UINT32 pad = 0;
            if (FAILED(ac->GetCurrentPadding(&pad))) break;
            UINT32 avail = bufFrames - pad;
            if (!avail) continue;
            BYTE* data = nullptr;
            if (FAILED(rc->GetBuffer(avail, &data))) break;
            float* out = (float*)data;

            const uint64_t W = o->ring.w.load(std::memory_order_acquire);
            const int64_t fill = (int64_t)(W - R);
            const int64_t target = std::max<int64_t>(64, (int64_t)(g_baseLatencyMs + o->delayMs) * rate / 1000);
            const int64_t slack = rate / 4;                          // 250 ms
            const int64_t over = settle > 0 ? rate / 50 : slack;     // 20 ms while settling
            o->fillMs = (int)(fill * 1000 / rate);
            uint32_t i = 0;

            if (o->state == OS_PLAYING && (fill > target + over || fill < target - slack)) {
                // Delay was changed or something hiccuped: jump straight to target.
                if (fill > target) R = W - target;
                else o->state = OS_BUFFERING;
                frac = 0.0;
                ema = (double)target;
                ramp = kRamp;
            }
            if (o->state == OS_BUFFERING && fill >= target) {
                R = W - target;
                ema = (double)target;
                frac = 0.0;
                ramp = kRamp;
                o->state = OS_PLAYING;
            }
            if (o->state == OS_PLAYING) {
                // Gentle clock-drift correction: speed up / slow down by at most
                // 0.4% (inaudible) to keep the buffer at its target level.
                ema = ema * 0.97 + (double)(W - R) * 0.03;
                // A device stall (e.g. a Bluetooth hiccup) leaves this output
                // behind the others; if it stays >40 ms behind for a second,
                // catch up at once rather than over ~25 s of drift correction.
                highFor = ema - target > rate / 25 ? highFor + avail : 0;
                if (highFor > rate) {
                    R = W - target;
                    ema = (double)target;
                    frac = 0.0;
                    ramp = kRamp;
                    highFor = 0;
                }
                double err = (ema - (double)target) / rate;
                double step = 1.0 + std::max(-0.004, std::min(0.004, err * 0.3));
                const float vol = o->volPct * 0.01f;
                for (; i < avail; i++) {
                    if (W - R < 2) {
                        o->underruns++;
                        o->state = OS_BUFFERING;
                        break;
                    }
                    const uint64_t a = (R & Ring::kMask) * 2, b = ((R + 1) & Ring::kMask) * 2;
                    const float f = (float)frac;
                    const float g = ramp ? vol * (float)(kRamp - ramp--) / kRamp : vol;
                    out[2 * i] = (rb[a] + (rb[b] - rb[a]) * f) * g;
                    out[2 * i + 1] = (rb[a + 1] + (rb[b + 1] - rb[a + 1]) * f) * g;
                    frac += step;
                    while (frac >= 1.0) { frac -= 1.0; R++; }
                }
                o->ring.r.store(R, std::memory_order_release);
            }
            if (o->state == OS_PLAYING && settle > 0) settle -= avail;
            for (; i < avail; i++) out[2 * i] = out[2 * i + 1] = 0.0f;
            if (FAILED(rc->ReleaseBuffer(avail, 0))) break;
        }

        ac->Stop();
        SafeRelease(rc);
        SafeRelease(ac);
        if (g_running && o->enabled && !o->isSource) {
            Log("  [%d] %s: disconnected, waiting for it to come back...\n", o->listIdx, o->dev.name.c_str());
            o->state = OS_LOST;
            announced = true;
            for (int k = 0; k < 10 && g_running; k++) Sleep(100);
        }
    }
    if (mm) AvRevertMmThreadCharacteristics(mm);
    CloseHandle(ev);
    CoUninitialize();
    return 0;
}

// ------------------------------------------------------- network (Scream) --
// Compatible with https://github.com/duncanthrax/scream receivers/senders:
// UDP, 5-byte header + up to 1152 bytes of little-endian PCM.
static const char* kScreamGroup = "239.255.77.77";
static const int kScreamPayload = 1152;

// --------------------------------------------------------- data meter ------
// Every byte SoundMesh puts on (or takes off) the network is counted here and
// sorted by the other side's address. "Local" = private home-network ranges;
// anything else counts as internet. SoundMesh never resolves host names and
// sends with TTL 1, so this should stay at zero - the meter is there to prove it.
static std::atomic<uint64_t> g_bytesLocal{0}, g_bytesInternet{0};
static std::atomic<uint32_t> g_lastInternetPeer{0};  // network byte order, for the warning

static bool IsLocalAddr(in_addr a) {
    uint32_t ip = ntohl(a.s_addr);
    return (ip >> 24) == 10 ||                    // 10.0.0.0/8
           (ip >> 20) == (172u << 4 | 1) ||       // 172.16.0.0/12
           (ip >> 16) == (192u << 8 | 168) ||     // 192.168.0.0/16
           (ip >> 16) == (169u << 8 | 254) ||     // 169.254.0.0/16 link-local (cable between two PCs)
           (ip >> 24) == 127 ||                   // this PC
           (ip >> 28) == 0xE ||                   // multicast; ours is sent with TTL 1
           ip == 0xFFFFFFFF;                      // broadcast
}

static void CountBytes(in_addr peer, uint64_t n) {
    if (IsLocalAddr(peer)) g_bytesLocal += n;
    else {
        g_bytesInternet += n;
        g_lastInternetPeer = peer.s_addr;
    }
}

static void CountSocket(SOCKET s, uint64_t n) {
    sockaddr_in a = {};
    int len = sizeof(a);
    if (getpeername(s, (sockaddr*)&a, &len) == 0) CountBytes(a.sin_addr, n);
    else g_bytesInternet += n;  // unknown peer: be strict
}

static std::string FmtBytes(uint64_t b) {
    char t[32];
    if (b < 1024) snprintf(t, sizeof(t), "%llu bytes", (unsigned long long)b);
    else if (b < 1024 * 1024) snprintf(t, sizeof(t), "%.1f KB", b / 1024.0);
    else if (b < 1024ull * 1024 * 1024) snprintf(t, sizeof(t), "%.1f MB", b / 1048576.0);
    else snprintf(t, sizeof(t), "%.2f GB", b / 1073741824.0);
    return t;
}

// Independent check that does not trust the counters above: ask Windows for
// every TCP connection this process owns and flag any whose remote end is
// not on the local network.
struct ConnAudit {
    int local = 0, outside = 0;
    std::string outsideAddr;
};
static ConnAudit AuditConnections() {
    ConnAudit r;
    DWORD size = 0, pid = GetCurrentProcessId();
    GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
    std::vector<char> buf(size + 4096);
    size = (DWORD)buf.size();
    if (GetExtendedTcpTable(buf.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != NO_ERROR) return r;
    auto* t = (MIB_TCPTABLE_OWNER_PID*)buf.data();
    for (DWORD i = 0; i < t->dwNumEntries; i++) {
        const auto& row = t->table[i];
        if (row.dwOwningPid != pid || row.dwState == MIB_TCP_STATE_LISTEN) continue;
        in_addr a;
        a.s_addr = row.dwRemoteAddr;
        if (IsLocalAddr(a)) r.local++;
        else {
            r.outside++;
            char ip[32];
            inet_ntop(AF_INET, &a, ip, sizeof(ip));
            r.outsideAddr = ip;
        }
    }
    return r;
}

struct NetOut {
    SOCKET s = INVALID_SOCKET;
    std::vector<sockaddr_in> dests;
    int16_t acc[kScreamPayload / 2];
    int accFrames = 0;
    uint8_t rateByte = 1;
    std::atomic<uint64_t> packets{0};
};
static NetOut* g_net = nullptr;

static bool ScreamRateByte(uint32_t rate, uint8_t& b) {
    if (rate % 44100 == 0 && rate / 44100 < 128) { b = (uint8_t)(0x80 | rate / 44100); return true; }
    if (rate % 48000 == 0 && rate / 48000 < 128) { b = (uint8_t)(rate / 48000); return true; }
    return false;
}

static void NetSend(NetOut* n, const float* st, uint32_t frames) {
    const int perPacket = kScreamPayload / 4;  // 288 stereo 16-bit frames
    for (uint32_t i = 0; i < frames; i++) {
        for (int c = 0; c < 2; c++) {
            float v = st[2 * i + c] * 32767.0f;
            v = v > 32767.0f ? 32767.0f : (v < -32768.0f ? -32768.0f : v);
            n->acc[n->accFrames * 2 + c] = (int16_t)lrintf(v);
        }
        if (++n->accFrames == perPacket) {
            uint8_t pkt[5 + kScreamPayload];
            pkt[0] = n->rateByte;
            pkt[1] = 16;
            pkt[2] = 2;
            pkt[3] = 0x03;  // dwChannelMask = FL | FR
            pkt[4] = 0x00;
            memcpy(pkt + 5, n->acc, kScreamPayload);
            for (auto& d : n->dests)
                if (sendto(n->s, (const char*)pkt, sizeof(pkt), 0, (const sockaddr*)&d, sizeof(d)) > 0)
                    CountBytes(d.sin_addr, sizeof(pkt) + 28);  // + IP/UDP headers
            n->packets++;
            n->accFrames = 0;
        }
    }
}

static bool ParseIPv4(const std::string& s, in_addr& a) { return inet_pton(AF_INET, s.c_str(), &a) == 1; }

// --------------------------------------------------------------- source ----
enum SrcKind { SRC_LOOPBACK, SRC_MIC, SRC_NET };
struct SourceCfg {
    SrcKind kind = SRC_LOOPBACK;
    DevInfo dev;
    int listIdx = 0;
    int port = 4010;
    std::string iface;          // local IPv4 for multicast, empty = system default
    bool followDefault = false; // loopback of "whatever Windows' default device is"
};
static SourceCfg g_src;
static std::atomic<uint64_t> g_srcFrames{0};
static std::atomic<bool> g_needRestart{false};  // source rate changed; GUI restarts the engine

// Pause the output that is the captured device (it already plays the sound).
static void MarkSourceOutputs() {
    for (auto* o : Outputs()) o->isSource = (g_src.kind == SRC_LOOPBACK && o->dev.id == g_src.dev.id);
}

#include "web.inc"
#include "btsink.inc"
#include "btinfo.inc"

static void Distribute(const float* st, uint32_t frames) {
    for (auto* o : Outputs()) o->ring.Push(st, frames);
    if (g_web && g_web->active) g_web->ring.Push(st, frames);
    if (g_net) NetSend(g_net, st, frames);
    g_srcFrames += frames;
}

static DWORD WINAPI CaptureThread(LPVOID) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    std::vector<float> tmp;
    bool announced = false;

    while (g_running) {
        if (g_src.followDefault) {
            // Windows often makes freshly connected headphones the default:
            // keep capturing whatever the default is.
            std::wstring def = DefaultRenderId();
            if (!def.empty() && def != g_src.dev.id) {
                for (auto& d : ListDevices(eRender))
                    if (d.id == def) {
                        EnterCriticalSection(&g_outLock);
                        g_src.dev = d;
                        LeaveCriticalSection(&g_outLock);
                        Log("  Windows default output is now '%s' - capturing it (it plays directly).\n", d.name.c_str());
                    }
                MarkSourceOutputs();
            }
        }
        IAudioClient* ac = ActivateClient(g_src.dev.id);
        IAudioCaptureClient* cc = nullptr;
        WAVEFORMATEX* mix = nullptr;
        Fmt f;
        HRESULT hr = E_FAIL;
        if (ac && SUCCEEDED(ac->GetMixFormat(&mix)) && ParseFormat(mix, f)) {
            DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | (g_src.kind == SRC_LOOPBACK ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0);
            hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1000000, 0, mix, nullptr);
            if (SUCCEEDED(hr)) hr = ac->GetService(kIID_IAudioCaptureClient, (void**)&cc);
            if (SUCCEEDED(hr)) hr = ac->SetEventHandle(ev);
            if (SUCCEEDED(hr)) hr = ac->Start();
            if (SUCCEEDED(hr) && f.rate != g_rate) {
                // Outputs were opened at the old rate; feeding them this would
                // play at the wrong pitch. The GUI restarts; the CLI asks to.
                Log("  source now runs at %u Hz (was %u) - restarting...\n", f.rate, g_rate.load());
                g_needRestart = true;
                ac->Stop();
                SafeRelease(cc);
                SafeRelease(ac);
                if (mix) CoTaskMemFree(mix);
                while (g_running) Sleep(50);
                break;
            }
        }
        if (mix) CoTaskMemFree(mix);
        if (FAILED(hr)) {
            if (!announced) Log("! cannot open source '%s' (0x%08lx), retrying...\n", g_src.dev.name.c_str(), (unsigned long)hr);
            announced = true;
            SafeRelease(cc);
            SafeRelease(ac);
            for (int i = 0; i < 20 && g_running; i++) Sleep(100);
            continue;
        }
        if (announced) Log("  source back: %s\n", g_src.dev.name.c_str());
        announced = false;

        int tick = 0;
        while (g_running) {
            // Loopback only signals while something is playing; the timeout
            // keeps us polling either way.
            WaitForSingleObject(ev, 10);
            if (g_src.followDefault && ++tick % 100 == 0 && DefaultRenderId() != g_src.dev.id) break;  // ~1 s
            UINT32 n = 0;
            bool lost = false;
            while (SUCCEEDED(hr = cc->GetNextPacketSize(&n)) && n) {
                BYTE* data = nullptr;
                UINT32 frames = 0;
                DWORD fl = 0;
                if (FAILED(hr = cc->GetBuffer(&data, &frames, &fl, nullptr, nullptr))) break;
                if (tmp.size() < frames * 2) tmp.resize(frames * 2);
                if (fl & AUDCLNT_BUFFERFLAGS_SILENT) memset(tmp.data(), 0, frames * 2 * sizeof(float));
                else ToStereo(data, frames, f, tmp.data());
                cc->ReleaseBuffer(frames);
                Distribute(tmp.data(), frames);
            }
            if (FAILED(hr)) lost = true;
            if (lost) break;
        }
        ac->Stop();
        SafeRelease(cc);
        SafeRelease(ac);
        if (g_running && FAILED(hr)) {
            Log("! source lost (0x%08lx), reconnecting...\n", (unsigned long)hr);
            announced = true;
            Sleep(500);
        }
    }
    if (mm) AvRevertMmThreadCharacteristics(mm);
    CloseHandle(ev);
    CoUninitialize();
    return 0;
}

static void StartOutputs();

static DWORD WINAPI NetReceiveThread(LPVOID) {
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    BOOL yes = TRUE;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));
    int rcvbuf = 1 << 20;
    setsockopt(s, SOL_SOCKET, SO_RCVBUF, (const char*)&rcvbuf, sizeof(rcvbuf));
    DWORD tmo = 300;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof(tmo));
    sockaddr_in a = {};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)g_src.port);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s, (sockaddr*)&a, sizeof(a)) != 0) {
        Log("! cannot listen on UDP port %d (error %d). Is another receiver running?\n", g_src.port, WSAGetLastError());
        g_running = false;
        closesocket(s);
        return 0;
    }
    ip_mreq mr = {};
    ParseIPv4(kScreamGroup, mr.imr_multiaddr);
    mr.imr_interface.s_addr = htonl(INADDR_ANY);
    if (!g_src.iface.empty()) ParseIPv4(g_src.iface, mr.imr_interface);
    if (setsockopt(s, IPPROTO_IP, IP_ADD_MEMBERSHIP, (const char*)&mr, sizeof(mr)) != 0)
        Log("  (could not join multicast group, unicast still works; error %d)\n", WSAGetLastError());
    Log("  listening on UDP %d (multicast %s and unicast)\n", g_src.port, kScreamGroup);

    uint8_t pkt[2048];
    std::vector<float> tmp(4096);
    bool haveRate = false;
    uint8_t lastHdr[3] = {0, 0, 0};
    while (g_running) {
        sockaddr_in from = {};
        int fromLen = sizeof(from);
        int n = recvfrom(s, (char*)pkt, sizeof(pkt), 0, (sockaddr*)&from, &fromLen);
        if (n > 0) CountBytes(from.sin_addr, (uint64_t)n + 28);
        if (n <= 5 || !IsLocalAddr(from.sin_addr)) continue;  // only accept audio from this network
        Fmt f;
        f.rate = ((pkt[0] & 0x80) ? 44100u : 48000u) * (pkt[0] & 0x7F);
        f.bits = pkt[1];
        f.channels = pkt[2];
        f.isFloat = false;
        if (!f.rate || !f.channels || (f.bits != 16 && f.bits != 24 && f.bits != 32)) continue;
        if (memcmp(lastHdr, pkt, 3) != 0) {
            Log("  stream: %u Hz, %u-bit, %u ch\n", f.rate, f.bits, f.channels);
            memcpy(lastHdr, pkt, 3);
        }
        if (!haveRate) {
            g_rate = f.rate;
            haveRate = true;
            StartOutputs();  // devices are opened at the stream's rate
        } else if (f.rate != g_rate) continue;  // outputs are opened at the first rate seen
        uint32_t frames = (uint32_t)(n - 5) / (f.bits / 8 * f.channels);
        if (tmp.size() < frames * 2) tmp.resize(frames * 2);
        ToStereo(pkt + 5, frames, f, tmp.data());
        Distribute(tmp.data(), frames);
    }
    closesocket(s);
    if (mm) AvRevertMmThreadCharacteristics(mm);
    return 0;
}

// ------------------------------------------------------------------ CLI ----
[[maybe_unused]] static void PrintDevices(const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    Log("\nPlayback devices (outputs, and loopback sources):\n");
    for (size_t i = 0; i < play.size(); i++)
        Log("  [%zu] %s%s%s%s\n", i + 1, play[i].name.c_str(), play[i].isDefault ? "   <- Windows default" : "",
            IsHandsFree(play[i]) ? "   (Bluetooth call mode: low quality, avoid)" : "",
            IsAutoHeadphone(play[i]) ? (IsBluetooth(play[i]) ? "   [headphones, Bluetooth]" : "   [headphones]") : "");
    Log("\nRecording devices (mic sources):\n");
    for (size_t i = 0; i < rec.size(); i++)
        Log("  [m%zu] %s%s\n", i + 1, rec[i].name.c_str(), rec[i].isDefault ? "   <- Windows default" : "");
    if (play.empty() && rec.empty()) Log("  (none found)\n");
    Log("\n");
}

// Resolve "3" or "airpods" against a device list; returns 1-based index or 0.
static int Resolve(const std::string& tok, const std::vector<DevInfo>& devs) {
    if (tok.empty()) return 0;
    char* end = nullptr;
    long v = strtol(tok.c_str(), &end, 10);
    if (*end == '\0') return (v >= 1 && v <= (long)devs.size()) ? (int)v : 0;
    std::string t = Lower(tok);
    int hit = 0;
    for (size_t i = 0; i < devs.size(); i++) {
        if (Lower(devs[i].name).find(t) == std::string::npos) continue;
        if (!IsHandsFree(devs[i])) return (int)i + 1;  // prefer the stereo (A2DP) endpoint
        if (!hit) hit = (int)i + 1;
    }
    return hit;
}

static std::vector<std::string> Split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == sep) { out.push_back(cur); cur.clear(); }
        else cur += c;
    }
    out.push_back(cur);
    for (auto& t : out) {
        while (!t.empty() && isspace((unsigned char)t.back())) t.pop_back();
        while (!t.empty() && isspace((unsigned char)t.front())) t.erase(t.begin());
    }
    return out;
}

[[maybe_unused]] static std::string ReadLine(const char* prompt) {
    Log("%s", prompt);
    char buf[512];
    if (!fgets(buf, sizeof(buf), stdin)) { g_running = false; return std::string(); }
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    return s;
}

[[maybe_unused]] static void Usage() {
    Log(
        "SoundMesh " SM_VERSION " - play one sound on many headphones/speakers/PCs at once.\n\n"
        "  soundmesh-cli                  interactive setup in the console\n"
        "  soundmesh-cli list                 show devices and their numbers\n"
        "  soundmesh-cli bt                   open Windows Bluetooth settings (pair headphones there)\n"
        "  soundmesh-cli btinfo               report what each Bluetooth device is built on (read-only)\n"
        "  soundmesh-cli [options]        (soundmesh.exe takes the same options and starts playing)\n\n"
        "Options:\n"
        "  --from loop        capture what the default playback device plays (default)\n"
        "  --from loop:N      capture what playback device N plays\n"
        "  --from mic:N       capture recording device N (number from `list`, without the m)\n"
        "  --from net         receive a SoundMesh/Scream stream from the LAN\n"
        "  --to auto          every headphone found, now and when switched on later (default)\n"
        "  --to A,B,...       outputs: device numbers or name parts, e.g. --to 2,3 or --to \"WH-1000,AirPods\"\n"
        "  --net multicast    also send to the LAN as multicast 239.255.77.77\n"
        "  --net IP,IP,...    also send to these LAN computers/phones (unicast, best on Wi-Fi)\n"
        "  --port P           UDP port (default 4010)\n"
        "  --iface IP         local IPv4 to use for multicast (pick the right adapter)\n"
        "  --latency MS       base buffer for every output (default 60, net source 120)\n"
        "  --buffer MS        device buffer per output (default 30; 100 if you hear crackling)\n"
        "  --phones           phones listen over Wi-Fi: open http://<this-pc>:4011 in the phone's browser\n"
        "  --phone-port P     port for --phones (default 4011)\n"
        "  --phone-in         make this PC a Bluetooth speaker for paired phones\n"
        "  --delay N=MS,...   extra delay for output N, to line up headphones (lip sync)\n"
        "  --vol N=PCT,...    volume for output N in percent (default 100)\n\n"
        "While running, type:  s = status   d N MS = set delay   v N PCT = set volume\n"
        "                      l MS = base latency   q = quit\n");
}

[[maybe_unused]] static BOOL WINAPI OnCtrl(DWORD) {
    g_running = false;
    return TRUE;
}

struct Options {
    std::string from = "loop";
    std::string to = "auto";
    std::string net;
    std::string delays, vols;
    int latency = -1;
    int deviceBuffer = 30;
    bool waitForDevices = false;  // start even with no outputs yet (auto mode)
    bool phones = false;          // serve the phone page / WAV stream
    int phonePort = 4011;
    bool phoneIn = false;         // be a Bluetooth speaker for phones
};

static void ApplyKV(const std::string& spec, bool isDelay) {
    for (auto& kv : Split(spec, ',')) {
        auto p = Split(kv, '=');
        if (p.size() != 2) continue;
        int idx = atoi(p[0].c_str()), val = atoi(p[1].c_str());
        for (auto* o : Outputs())
            if (o->listIdx == idx) (isDelay ? o->delayMs : o->volPct) = std::max(0, std::min(isDelay ? 2000 : 400, val));
    }
}

[[maybe_unused]] static void PrintStatus() {
    uint32_t rate = g_rate;
    const char* kind = g_src.kind == SRC_NET ? "LAN stream" : (g_src.kind == SRC_MIC ? "mic" : "loopback");
    Log("source: %s %s | %u Hz | %.1f s received\n", kind, g_src.dev.name.c_str(), rate, (double)g_srcFrames / rate);
    for (auto* o : Outputs())
        Log("  [%d] %-40s %-12s buffer %4d ms  delay %4d ms  vol %3d%%  dropouts %u\n", o->listIdx, o->dev.name.c_str(),
            kStateName[o->state], o->fillMs.load(), o->delayMs.load(), o->volPct.load(), o->underruns.load());
    if (g_net) Log("  [net] %zu destination(s), %llu packets sent\n", g_net->dests.size(), (unsigned long long)g_net->packets);
    ConnAudit au = AuditConnections();
    Log("  data: %s on your local network, %s to/from the internet; %d open connection(s), %d outside your network\n",
        FmtBytes(g_bytesLocal).c_str(), FmtBytes(g_bytesInternet).c_str(), au.local + au.outside, au.outside);
}

// ------------------------------------------------------------- engine ------
static HANDLE g_srcThread = nullptr;

static void Cleanup() {
    for (auto* o : Outputs()) {
        if (o->thread) { WaitForSingleObject(o->thread, 3000); CloseHandle(o->thread); }
        delete o;
    }
    g_nOuts = 0;
    g_outputsLive = false;
    if (g_net) {
        closesocket(g_net->s);
        delete g_net;
        g_net = nullptr;
    }
}

// Open every output device at g_rate. Called once the source rate is known:
// right away for local sources, on the first packet for a LAN source.
static void StartOutputs() {
    if (g_net && !g_net->dests.empty() && !ScreamRateByte(g_rate, g_net->rateByte)) {
        Log("! %u Hz can't be sent to the LAN (needs a multiple of 44100 or 48000); LAN output disabled.\n", g_rate.load());
        g_net->dests.clear();
    }
    EnterCriticalSection(&g_outLock);
    for (auto* o : Outputs())
        if (!o->thread) o->thread = CreateThread(nullptr, 0, OutputThread, o, 0, nullptr);
    g_outputsLive = true;
    LeaveCriticalSection(&g_outLock);
}

// Add an output, also while running (it starts playing right away). An
// output that already exists is just re-enabled.
static Output* AddOutput(const DevInfo& d, int listIdx) {
    for (auto* o : Outputs())
        if (o->dev.id == d.id) {
            o->enabled = true;
            return o;
        }
    int n = g_nOuts.load();
    if (n >= kMaxOutputs) return nullptr;
    Output* o = new Output();
    o->listIdx = listIdx;
    o->dev = d;
    o->isSource = (g_src.kind == SRC_LOOPBACK && d.id == g_src.dev.id);
    EnterCriticalSection(&g_outLock);
    g_outs[n] = o;
    g_nOuts.store(n + 1, std::memory_order_release);
    if (g_outputsLive && g_running) o->thread = CreateThread(nullptr, 0, OutputThread, o, 0, nullptr);
    LeaveCriticalSection(&g_outLock);
    return o;
}

static void Stop() {
    g_running = false;
    if (g_srcThread) {
        WaitForSingleObject(g_srcThread, 3000);
        CloseHandle(g_srcThread);
        g_srcThread = nullptr;
    }
    Cleanup();
}

// Validate options, open everything and start the audio threads.
// Returns false (with the reason logged and in g_lastError) on bad options.
static bool Start(Options opt, const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    g_lastError.clear();
    g_srcFrames = 0;
    g_needRestart = false;
    g_src.followDefault = false;
    g_baseLatencyMs = 60;
    g_src.dev = DevInfo();

    // ---- source
    std::string from = Lower(opt.from);
    if (from == "net") {
        g_src.kind = SRC_NET;
        g_src.dev.name = "(LAN)";
    } else if (from.rfind("mic", 0) == 0) {
        g_src.kind = SRC_MIC;
        int i = from.size() > 4 ? Resolve(opt.from.substr(4), rec) : 0;
        if (!i) for (size_t k = 0; k < rec.size(); k++) if (rec[k].isDefault) i = (int)k + 1;
        if (!i) { Log("! no such recording device: %s\n", opt.from.c_str()); return false; }
        g_src.dev = rec[i - 1];
        g_src.listIdx = i;
    } else {
        g_src.kind = SRC_LOOPBACK;
        int i = from.size() > 5 ? Resolve(opt.from.substr(5), play) : 0;
        if (!i) {
            std::wstring def = DefaultRenderId();
            for (size_t k = 0; k < play.size(); k++) if (play[k].id == def) i = (int)k + 1;
            if (!i) for (size_t k = 0; k < play.size(); k++) if (play[k].isDefault) i = (int)k + 1;
            g_src.followDefault = true;
        }
        if (!i) { Log("! no such playback device: %s\n", opt.from.c_str()); return false; }
        g_src.dev = play[i - 1];
        g_src.listIdx = i;
    }

    // ---- outputs ("auto" = every detected headphone)
    for (auto& tok : Split(opt.to, ',')) {
        if (tok.empty()) continue;
        if (Lower(tok) == "auto") {
            int found = 0;
            for (size_t k = 0; k < play.size(); k++)
                if (IsAutoHeadphone(play[k])) { AddOutput(play[k], (int)k + 1); found++; }
            if (!found) Log("  no headphones detected yet - switch them on, they join automatically.\n");
            continue;
        }
        int i = Resolve(tok, play);
        if (!i) { Log("! no playback device matches '%s'\n", tok.c_str()); Cleanup(); return false; }
        AddOutput(play[i - 1], i);  // if it is the captured device it just pauses ("plays directly")
    }

    // ---- network out
    std::string net = Lower(opt.net);
    if (!net.empty() && net != "no") {
        g_net = new NetOut();
        g_net->s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        // TTL 1: packets never leave the local network, so no internet quota.
        DWORD ttl = 1;
        setsockopt(g_net->s, IPPROTO_IP, IP_MULTICAST_TTL, (const char*)&ttl, sizeof(ttl));
        setsockopt(g_net->s, IPPROTO_IP, IP_TTL, (const char*)&ttl, sizeof(ttl));
        if (!g_src.iface.empty()) {
            in_addr ifa;
            if (ParseIPv4(g_src.iface, ifa)) setsockopt(g_net->s, IPPROTO_IP, IP_MULTICAST_IF, (const char*)&ifa, sizeof(ifa));
        }
        std::vector<std::string> targets = net == "multicast" ? std::vector<std::string>{kScreamGroup} : Split(opt.net, ',');
        for (auto& t : targets) {
            if (t.empty()) continue;
            sockaddr_in d = {};
            d.sin_family = AF_INET;
            d.sin_port = htons((u_short)g_src.port);
            if (!ParseIPv4(t, d.sin_addr)) { Log("! not an IPv4 address: %s\n", t.c_str()); Cleanup(); return false; }
            g_net->dests.push_back(d);
        }
    }

    if (!g_nOuts && !g_net && !opt.waitForDevices) {
        Log("! nothing to play to: pick at least one output or a LAN address\n");
        return false;
    }

    // ---- sample rate
    if (g_src.kind == SRC_NET) {
        if (opt.latency < 0) opt.latency = 120;  // Wi-Fi jitter
    } else {
        IAudioClient* ac = ActivateClient(g_src.dev.id);
        WAVEFORMATEX* mix = nullptr;
        Fmt f;
        bool ok = ac && SUCCEEDED(ac->GetMixFormat(&mix)) && ParseFormat(mix, f);
        if (mix) CoTaskMemFree(mix);
        SafeRelease(ac);
        if (!ok) { Log("! cannot read the format of '%s'\n", g_src.dev.name.c_str()); Cleanup(); return false; }
        g_rate = f.rate;
    }
    if (opt.latency >= 0) g_baseLatencyMs = std::max(10, std::min(1000, opt.latency));
    g_deviceBufferMs = std::max(10, std::min(500, opt.deviceBuffer));
    ApplyKV(opt.delays, true);
    ApplyKV(opt.vols, false);

    // ---- go
    const char* kind = g_src.kind == SRC_NET ? "LAN stream" : (g_src.kind == SRC_MIC ? "microphone" : "loopback of");
    Log("Source : %s %s\n", kind, g_src.kind == SRC_NET ? "" : g_src.dev.name.c_str());
    for (auto* o : Outputs())
        Log("Output : [%d] %s%s\n", o->listIdx, o->dev.name.c_str(), o->isSource ? "  (Windows default - plays directly)" : "");
    if (g_net) for (auto& d : g_net->dests) {
        char ip[32];
        inet_ntop(AF_INET, &d.sin_addr, ip, sizeof(ip));
        Log("Output : LAN %s:%d\n", ip, g_src.port);
    }
    Log("Base latency %d ms, device buffer %d ms.\n", g_baseLatencyMs.load(), g_deviceBufferMs.load());

    g_running = true;
    if (g_src.kind == SRC_NET) {
        Log("  waiting for a stream on the LAN...\n");
        g_srcThread = CreateThread(nullptr, 0, NetReceiveThread, nullptr, 0, nullptr);
    } else {
        StartOutputs();
        g_srcThread = CreateThread(nullptr, 0, CaptureThread, nullptr, 0, nullptr);
    }
    return true;
}

// Shared by both builds: returns false on a bad option. Sets *verb for
// `list` / `bt` / `help`.
static bool ParseArgs(int argc, char** argv, Options& opt, std::string* verb) {
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&](std::string& dst) { if (i + 1 < argc) dst = argv[++i]; };
        std::string tmp;
        if (a == "list" || a == "bt" || a == "btinfo") *verb = a;
        else if (a == "-h" || a == "--help" || a == "help" || a == "/?") *verb = "help";
        else if (a == "--from") next(opt.from);
        else if (a == "--to") next(opt.to);
        else if (a == "--net") next(opt.net);
        else if (a == "--delay") next(opt.delays);
        else if (a == "--vol") next(opt.vols);
        else if (a == "--iface") next(g_src.iface);
        else if (a == "--port") { next(tmp); g_src.port = atoi(tmp.c_str()); }
        else if (a == "--latency") { next(tmp); opt.latency = atoi(tmp.c_str()); }
        else if (a == "--buffer") { next(tmp); opt.deviceBuffer = atoi(tmp.c_str()); }
        else if (a == "--phones") opt.phones = true;
        else if (a == "--phone-port") { next(tmp); opt.phonePort = atoi(tmp.c_str()); }
        else if (a == "--phone-in") opt.phoneIn = true;
        else { Log("! unknown option: %s\n", a.c_str()); return false; }
    }
    return true;
}

static void OpenBluetoothSettings() { ShellExecuteW(nullptr, L"open", L"ms-settings:bluetooth", nullptr, nullptr, SW_SHOWNORMAL); }

#ifdef SM_CONSOLE
// ------------------------------------------------------------ console ------
static std::string Quote(const std::string& s) {
    return s.find_first_of(" ,") == std::string::npos ? s : "\"" + s + "\"";
}

static void Wizard(Options& opt, const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    Log("SoundMesh " SM_VERSION " - one sound, many headphones.\n");
    Log("Pair every headphone in Windows Bluetooth settings first (type 'bt' to open them).\n");
    PrintDevices(play, rec);

    std::string s = ReadLine("Source? [Enter = what the Windows default device plays | loop:N | mic:N | net]: ");
    if (s == "bt") { OpenBluetoothSettings(); s = ReadLine("Source? "); }
    // Accept the numbers exactly as the list shows them: "2" = loop:2, "m1" = mic:1.
    if (s.empty()) opt.from = "loop";
    else if (isdigit((unsigned char)s[0])) opt.from = "loop:" + s;
    else if ((s[0] == 'm' || s[0] == 'M') && s.size() > 1 && isdigit((unsigned char)s[1])) opt.from = "mic:" + s.substr(1);
    else opt.from = s;

    opt.to = ReadLine("Play on which devices? [Enter = all headphones, automatically | numbers, e.g. 2,3]: ");
    if (opt.to.empty()) opt.to = "auto";
    std::string n = ReadLine("Also send over the LAN? [Enter = no | m = multicast | IPs, comma separated]: ");
    opt.net = (Lower(n) == "m") ? "multicast" : n;

    std::string cmd = "soundmesh-cli --from " + Quote(opt.from);
    if (!opt.to.empty()) cmd += " --to " + Quote(opt.to);
    if (!opt.net.empty()) cmd += " --net " + opt.net;
    Log("\nTip: make a shortcut with this command to skip these questions:\n  %s\n\n", cmd.c_str());
}

// --to auto: headphones switched on later join while running.
static DWORD WINAPI AutoWatchThread(LPVOID) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (g_running) {
        for (int i = 0; i < 20 && g_running; i++) Sleep(100);
        for (auto& d : ListDevices(eRender)) {
            bool known = false;
            for (auto* o : Outputs()) known |= (o->dev.id == d.id);
            if (!known && IsAutoHeadphone(d) && AddOutput(d, 0)) Log("  + %s joined\n", d.name.c_str());
        }
    }
    CoUninitialize();
    return 0;
}

int main(int argc, char** argv) {
    InitializeCriticalSection(&g_logLock);
    InitializeCriticalSection(&g_outLock);
    InitializeCriticalSection(&g_bt.lock);
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(OnCtrl, TRUE);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    timeBeginPeriod(1);

    Options opt;
    std::string verb;
    if (!ParseArgs(argc, argv, opt, &verb)) { Usage(); return 1; }
    if (verb == "help") { Usage(); return 0; }
    if (verb == "bt") { OpenBluetoothSettings(); return 0; }
    auto play = ListDevices(eRender);
    auto rec = ListDevices(eCapture);
    if (verb == "list") { PrintDevices(play, rec); return 0; }
    if (verb == "btinfo") {
        std::string t = BluetoothReportText();
        for (size_t p; (p = t.find('\r')) != std::string::npos;) t.erase(p, 1);
        Log("%s", t.c_str());
        return 0;
    }

    bool interactive = argc == 1;
    if (interactive) Wizard(opt, play, rec);
    int rc = 0;
    bool autoTo = false;
    for (auto& t : Split(opt.to, ',')) autoTo |= Lower(t) == "auto";
    opt.waitForDevices = autoTo;
    if (g_running && Start(opt, play, rec)) {
        HANDLE watch = autoTo ? CreateThread(nullptr, 0, AutoWatchThread, nullptr, 0, nullptr) : nullptr;
        if (opt.phones && StartWeb(opt.phonePort)) {
            Log("Phones: open one of these in the phone's browser (same Wi-Fi):\n");
            for (auto& ip : LocalIPv4s()) Log("  http://%s:%d   (%s)\n", ip.ip.c_str(), opt.phonePort, ip.adapter.c_str());
        }
        if (opt.phoneIn) StartBtSink();
        Log("Type 's' for status, 'q' to quit.\n\n");
        while (g_running) {
            std::string line = ReadLine("");
            if (!g_running) break;
            auto p = Split(line, ' ');
            if (p.empty() || p[0].empty()) continue;
            char c = (char)tolower((unsigned char)p[0][0]);
            if (c == 'q') break;
            else if (c == 's') PrintStatus();
            else if ((c == 'd' || c == 'v') && p.size() == 3) {
                ApplyKV(p[1] + "=" + p[2], c == 'd');
                PrintStatus();
            } else if (c == 'l' && p.size() == 2) {
                g_baseLatencyMs = std::max(10, std::min(1000, atoi(p[1].c_str())));
                Log("base latency %d ms\n", g_baseLatencyMs.load());
            } else Log("commands: s | d N MS | v N PCT | l MS | q\n");
        }
        g_running = false;
        if (watch) { WaitForSingleObject(watch, 3000); CloseHandle(watch); }
        StopWeb();
        StopBtSink();
        Stop();
        Log("bye\n");
    } else rc = 1;
    if (interactive && rc) ReadLine("\nPress Enter to close.");
    timeEndPeriod(1);
    WSACleanup();
    CoUninitialize();
    return rc;
}
#else
#include "gui.inc"
#endif

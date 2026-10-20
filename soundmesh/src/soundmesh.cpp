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

#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define SM_VERSION "1.0.0"

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

template <class T> static void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// -------------------------------------------------------------- logging ----
static CRITICAL_SECTION g_logLock;

static void Log(const char* fmt, ...) {
    EnterCriticalSection(&g_logLock);
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fflush(stdout);
    LeaveCriticalSection(&g_logLock);
}

static std::string Utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::string Lower(std::string s) {
    for (auto& c : s) c = (char)tolower((unsigned char)c);
    return s;
}

// -------------------------------------------------------------- globals ----
static std::atomic<bool> g_running{true};
static std::atomic<uint32_t> g_rate{48000};      // internal sample rate (Hz), stereo float
static std::atomic<int> g_baseLatencyMs{60};    // buffering every output keeps before playing
static HANDLE g_rateKnown = nullptr;             // signalled once g_rate is valid (net source)

// ----------------------------------------------------------- devices -------
struct DevInfo {
    std::wstring id;
    std::string name;
    bool isDefault = false;
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

static bool IsHandsFree(const std::string& name) {
    std::string l = Lower(name);
    return l.find("hands-free") != std::string::npos || l.find("handsfree") != std::string::npos;
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
enum OutState { OS_CONNECTING, OS_BUFFERING, OS_PLAYING, OS_LOST };
static const char* kStateName[] = {"connecting", "buffering", "playing", "reconnecting"};

struct Output {
    int listIdx = 0;  // number shown by `list`
    DevInfo dev;
    Ring ring;
    std::atomic<int> delayMs{0};
    std::atomic<int> volPct{100};
    std::atomic<int> state{OS_CONNECTING};
    std::atomic<int> fillMs{0};
    std::atomic<uint32_t> underruns{0};
    HANDLE thread = nullptr;
};

static std::vector<Output*> g_outputs;

static DWORD WINAPI OutputThread(LPVOID arg) {
    Output* o = (Output*)arg;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD task = 0;
    HANDLE mm = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    bool announced = false;

    while (g_running) {
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
            hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | conv, 300000, 0, (WAVEFORMATEX*)&wf, nullptr);
            if (FAILED(hr)) {
                // Some older drivers refuse event mode together with conversion.
                SafeRelease(ac);
                ac = ActivateClient(o->dev.id);
                useEvent = false;
                if (ac) hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, conv, 600000, 0, (WAVEFORMATEX*)&wf, nullptr);
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
        uint64_t R = o->ring.r.load(std::memory_order_relaxed);
        const float* rb = o->ring.buf;

        while (g_running) {
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
            const int64_t slack = rate / 4;  // 250 ms
            o->fillMs = (int)(fill * 1000 / rate);
            uint32_t i = 0;

            if (o->state == OS_PLAYING && (fill > target + slack || fill < target - slack)) {
                // Delay was changed or something hiccuped: jump straight to target.
                if (fill > target) R = W - target;
                else o->state = OS_BUFFERING;
                frac = 0.0;
                ema = (double)target;
            }
            if (o->state == OS_BUFFERING && fill >= target) {
                R = W - target;
                ema = (double)target;
                frac = 0.0;
                o->state = OS_PLAYING;
            }
            if (o->state == OS_PLAYING) {
                // Gentle clock-drift correction: speed up / slow down by at most
                // 0.4% (inaudible) to keep the buffer at its target level.
                ema = ema * 0.97 + (double)(W - R) * 0.03;
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
                    out[2 * i] = (rb[a] + (rb[b] - rb[a]) * f) * vol;
                    out[2 * i + 1] = (rb[a + 1] + (rb[b + 1] - rb[a + 1]) * f) * vol;
                    frac += step;
                    while (frac >= 1.0) { frac -= 1.0; R++; }
                }
                o->ring.r.store(R, std::memory_order_release);
            }
            for (; i < avail; i++) out[2 * i] = out[2 * i + 1] = 0.0f;
            if (FAILED(rc->ReleaseBuffer(avail, 0))) break;
        }

        ac->Stop();
        SafeRelease(rc);
        SafeRelease(ac);
        if (g_running) {
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
            for (auto& d : n->dests) sendto(n->s, (const char*)pkt, sizeof(pkt), 0, (const sockaddr*)&d, sizeof(d));
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
    std::string iface;  // local IPv4 for multicast, empty = system default
};
static SourceCfg g_src;
static std::atomic<uint64_t> g_srcFrames{0};

static void Distribute(const float* st, uint32_t frames) {
    for (auto* o : g_outputs) o->ring.Push(st, frames);
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
            if (SUCCEEDED(hr) && f.rate != g_rate)
                Log("! source sample rate changed to %u Hz; restart SoundMesh to match it.\n", f.rate);
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

        while (g_running) {
            // Loopback only signals while something is playing; the timeout
            // keeps us polling either way.
            WaitForSingleObject(ev, 10);
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
        if (g_running) {
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
        SetEvent(g_rateKnown);
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
        int n = recv(s, (char*)pkt, sizeof(pkt), 0);
        if (n <= 5) continue;
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
            SetEvent(g_rateKnown);
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
static void PrintDevices(const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    Log("\nPlayback devices (outputs, and loopback sources):\n");
    for (size_t i = 0; i < play.size(); i++)
        Log("  [%zu] %s%s%s\n", i + 1, play[i].name.c_str(), play[i].isDefault ? "   <- Windows default" : "",
            IsHandsFree(play[i].name) ? "   (Bluetooth call mode: low quality, avoid)" : "");
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
        if (!IsHandsFree(devs[i].name)) return (int)i + 1;  // prefer the stereo (A2DP) endpoint
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

static std::string ReadLine(const char* prompt) {
    Log("%s", prompt);
    char buf[512];
    if (!fgets(buf, sizeof(buf), stdin)) { g_running = false; return std::string(); }
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    return s;
}

static void Usage() {
    Log(
        "SoundMesh " SM_VERSION " - play one sound on many headphones/speakers/PCs at once.\n\n"
        "  soundmesh                      interactive setup (just double-click the exe)\n"
        "  soundmesh list                 show devices and their numbers\n"
        "  soundmesh bt                   open Windows Bluetooth settings (pair headphones there)\n"
        "  soundmesh [options]\n\n"
        "Options:\n"
        "  --from loop        capture what the default playback device plays (default)\n"
        "  --from loop:N      capture what playback device N plays\n"
        "  --from mic:N       capture recording device N (number from `list`, without the m)\n"
        "  --from net         receive a SoundMesh/Scream stream from the LAN\n"
        "  --to A,B,...       outputs: device numbers or name parts, e.g. --to 2,3 or --to \"WH-1000,AirPods\"\n"
        "  --net multicast    also send to the LAN as multicast 239.255.77.77\n"
        "  --net IP,IP,...    also send to these LAN computers/phones (unicast, best on Wi-Fi)\n"
        "  --port P           UDP port (default 4010)\n"
        "  --iface IP         local IPv4 to use for multicast (pick the right adapter)\n"
        "  --latency MS       base buffer for every output (default 60, net source 120)\n"
        "  --delay N=MS,...   extra delay for output N, to line up headphones (lip sync)\n"
        "  --vol N=PCT,...    volume for output N in percent (default 100)\n\n"
        "While running, type:  s = status   d N MS = set delay   v N PCT = set volume\n"
        "                      l MS = base latency   q = quit\n");
}

static BOOL WINAPI OnCtrl(DWORD) {
    g_running = false;
    return TRUE;
}

struct Options {
    std::string from = "loop";
    std::string to;
    std::string net;
    std::string delays, vols;
    int latency = -1;
};

static void ApplyKV(const std::string& spec, bool isDelay) {
    for (auto& kv : Split(spec, ',')) {
        auto p = Split(kv, '=');
        if (p.size() != 2) continue;
        int idx = atoi(p[0].c_str()), val = atoi(p[1].c_str());
        for (auto* o : g_outputs)
            if (o->listIdx == idx) (isDelay ? o->delayMs : o->volPct) = std::max(0, std::min(isDelay ? 2000 : 400, val));
    }
}

static void PrintStatus() {
    uint32_t rate = g_rate;
    const char* kind = g_src.kind == SRC_NET ? "LAN stream" : (g_src.kind == SRC_MIC ? "mic" : "loopback");
    Log("source: %s %s | %u Hz | %.1f s received\n", kind, g_src.dev.name.c_str(), rate, (double)g_srcFrames / rate);
    for (auto* o : g_outputs)
        Log("  [%d] %-40s %-12s buffer %4d ms  delay %4d ms  vol %3d%%  dropouts %u\n", o->listIdx, o->dev.name.c_str(),
            kStateName[o->state], o->fillMs.load(), o->delayMs.load(), o->volPct.load(), o->underruns.load());
    if (g_net) Log("  [net] %zu destination(s), %llu packets sent\n", g_net->dests.size(), (unsigned long long)g_net->packets);
}

static int Run(Options& opt, const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    // ---- source
    std::string from = Lower(opt.from);
    if (from == "net") {
        g_src.kind = SRC_NET;
        g_src.dev.name = "(LAN)";
    } else if (from.rfind("mic", 0) == 0) {
        g_src.kind = SRC_MIC;
        int i = from.size() > 4 ? Resolve(opt.from.substr(4), rec) : 0;
        if (!i) for (size_t k = 0; k < rec.size(); k++) if (rec[k].isDefault) i = (int)k + 1;
        if (!i) { Log("! no such recording device: %s\n", opt.from.c_str()); return 1; }
        g_src.dev = rec[i - 1];
        g_src.listIdx = i;
    } else {
        g_src.kind = SRC_LOOPBACK;
        int i = from.size() > 5 ? Resolve(opt.from.substr(5), play) : 0;
        if (!i) for (size_t k = 0; k < play.size(); k++) if (play[k].isDefault) i = (int)k + 1;
        if (!i) { Log("! no such playback device: %s\n", opt.from.c_str()); return 1; }
        g_src.dev = play[i - 1];
        g_src.listIdx = i;
    }

    // ---- outputs
    if (!opt.to.empty()) {
        for (auto& tok : Split(opt.to, ',')) {
            if (tok.empty()) continue;
            int i = Resolve(tok, play);
            if (!i) { Log("! no playback device matches '%s' (try `soundmesh list`)\n", tok.c_str()); return 1; }
            if (g_src.kind == SRC_LOOPBACK && i == g_src.listIdx) {
                Log("! [%d] %s is the loopback source; sending it its own sound would echo forever.\n"
                    "  Make a different device the Windows default, or use --from loop:N.\n", i, play[i - 1].name.c_str());
                return 1;
            }
            bool dup = false;
            for (auto* o : g_outputs) dup |= (o->listIdx == i);
            if (dup) continue;
            Output* o = new Output();
            o->listIdx = i;
            o->dev = play[i - 1];
            g_outputs.push_back(o);
        }
    }

    // ---- network out
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    if (!opt.net.empty() && Lower(opt.net) != "no") {
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
        std::vector<std::string> targets = Lower(opt.net) == "multicast" ? std::vector<std::string>{kScreamGroup} : Split(opt.net, ',');
        for (auto& t : targets) {
            if (t.empty()) continue;
            sockaddr_in d = {};
            d.sin_family = AF_INET;
            d.sin_port = htons((u_short)g_src.port);
            if (!ParseIPv4(t, d.sin_addr)) { Log("! not an IPv4 address: %s\n", t.c_str()); return 1; }
            g_net->dests.push_back(d);
        }
    }

    if (g_outputs.empty() && !g_net) { Log("! nothing to play to: give --to and/or --net\n"); return 1; }

    // ---- sample rate
    if (g_src.kind == SRC_NET) {
        if (opt.latency < 0) opt.latency = 120;  // Wi-Fi jitter
    } else {
        IAudioClient* ac = ActivateClient(g_src.dev.id);
        WAVEFORMATEX* mix = nullptr;
        Fmt f;
        if (!ac || FAILED(ac->GetMixFormat(&mix)) || !ParseFormat(mix, f)) {
            Log("! cannot read the format of '%s'\n", g_src.dev.name.c_str());
            return 1;
        }
        CoTaskMemFree(mix);
        SafeRelease(ac);
        g_rate = f.rate;
    }
    if (opt.latency >= 0) g_baseLatencyMs = std::max(10, std::min(1000, opt.latency));
    ApplyKV(opt.delays, true);
    ApplyKV(opt.vols, false);

    // ---- start
    const char* kind = g_src.kind == SRC_NET ? "LAN stream" : (g_src.kind == SRC_MIC ? "microphone" : "loopback of");
    Log("\nSource : %s %s\n", kind, g_src.kind == SRC_NET ? "" : g_src.dev.name.c_str());
    for (auto* o : g_outputs) Log("Output : [%d] %s\n", o->listIdx, o->dev.name.c_str());
    if (g_net) for (auto& d : g_net->dests) {
        char ip[32];
        inet_ntop(AF_INET, &d.sin_addr, ip, sizeof(ip));
        Log("Output : LAN %s:%d\n", ip, g_src.port);
    }
    Log("Base latency %d ms. Type 's' for status, 'q' to quit.\n\n", g_baseLatencyMs.load());

    HANDLE src = nullptr;
    if (g_src.kind == SRC_NET) {
        src = CreateThread(nullptr, 0, NetReceiveThread, nullptr, 0, nullptr);
        Log("  waiting for a stream on the LAN...\n");
        while (g_running && WaitForSingleObject(g_rateKnown, 200) == WAIT_TIMEOUT) {}
    }
    if (g_net && !ScreamRateByte(g_rate, g_net->rateByte)) {
        Log("! %u Hz can't be sent to the LAN (needs a multiple of 44100 or 48000); LAN output disabled.\n", g_rate.load());
        g_net->dests.clear();
    }
    for (auto* o : g_outputs) o->thread = CreateThread(nullptr, 0, OutputThread, o, 0, nullptr);
    if (g_src.kind != SRC_NET) src = CreateThread(nullptr, 0, CaptureThread, nullptr, 0, nullptr);

    // ---- console commands
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
    if (src) { WaitForSingleObject(src, 2000); CloseHandle(src); }
    for (auto* o : g_outputs) if (o->thread) { WaitForSingleObject(o->thread, 2000); CloseHandle(o->thread); }
    if (g_net) closesocket(g_net->s);
    WSACleanup();
    Log("bye\n");
    return 0;
}

static std::string Quote(const std::string& s) {
    return s.find_first_of(" ,") == std::string::npos ? s : "\"" + s + "\"";
}

static void Wizard(Options& opt, const std::vector<DevInfo>& play, const std::vector<DevInfo>& rec) {
    Log("SoundMesh " SM_VERSION " - one sound, many headphones.\n");
    Log("Pair every headphone in Windows Bluetooth settings first (type 'bt' to open them).\n");
    PrintDevices(play, rec);

    std::string s = ReadLine("Source? [Enter = what the Windows default device plays | loop:N | mic:N | net]: ");
    if (s == "bt") { ShellExecuteW(nullptr, L"open", L"ms-settings:bluetooth", nullptr, nullptr, SW_SHOWNORMAL); s = ReadLine("Source? "); }
    // Accept the numbers exactly as the list shows them: "2" = loop:2, "m1" = mic:1.
    if (s.empty()) opt.from = "loop";
    else if (isdigit((unsigned char)s[0])) opt.from = "loop:" + s;
    else if ((s[0] == 'm' || s[0] == 'M') && s.size() > 1 && isdigit((unsigned char)s[1])) opt.from = "mic:" + s.substr(1);
    else opt.from = s;

    opt.to = ReadLine("Play on which devices? (numbers, comma separated, e.g. 2,3; Enter = none): ");
    std::string n = ReadLine("Also send over the LAN? [Enter = no | m = multicast | IPs, comma separated]: ");
    opt.net = (Lower(n) == "m") ? "multicast" : n;

    std::string cmd = "soundmesh --from " + Quote(opt.from);
    if (!opt.to.empty()) cmd += " --to " + Quote(opt.to);
    if (!opt.net.empty()) cmd += " --net " + opt.net;
    Log("\nTip: make a shortcut with this command to skip these questions:\n  %s\n", cmd.c_str());
}

int main(int argc, char** argv) {
    InitializeCriticalSection(&g_logLock);
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(OnCtrl, TRUE);
    g_rateKnown = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    timeBeginPeriod(1);

    Options opt;
    bool interactive = argc == 1;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&](std::string& dst) { if (i + 1 < argc) dst = argv[++i]; };
        std::string tmp;
        if (a == "list") {
            PrintDevices(ListDevices(eRender), ListDevices(eCapture));
            return 0;
        } else if (a == "bt") {
            ShellExecuteW(nullptr, L"open", L"ms-settings:bluetooth", nullptr, nullptr, SW_SHOWNORMAL);
            return 0;
        } else if (a == "-h" || a == "--help" || a == "help" || a == "/?") {
            Usage();
            return 0;
        } else if (a == "--from") next(opt.from);
        else if (a == "--to") next(opt.to);
        else if (a == "--net") next(opt.net);
        else if (a == "--delay") next(opt.delays);
        else if (a == "--vol") next(opt.vols);
        else if (a == "--iface") next(g_src.iface);
        else if (a == "--port") { next(tmp); g_src.port = atoi(tmp.c_str()); }
        else if (a == "--latency") { next(tmp); opt.latency = atoi(tmp.c_str()); }
        else { Log("unknown option: %s\n\n", a.c_str()); Usage(); return 1; }
    }

    auto play = ListDevices(eRender);
    auto rec = ListDevices(eCapture);
    if (interactive) Wizard(opt, play, rec);
    int rc = g_running ? Run(opt, play, rec) : 0;
    if (interactive && rc) ReadLine("\nPress Enter to close.");
    timeEndPeriod(1);
    CoUninitialize();
    return rc;
}

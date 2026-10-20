// ----------------------------------------------------- phones (Wi-Fi) ------
// Any phone/tablet/PC on the same network can listen in its browser:
//   http://<this-pc>:4011/            page with a Play button (WebSocket + Web Audio)
//   http://<this-pc>:4011/stream.wav  endless WAV for VLC, smart TVs, Wi-Fi speakers
// Plain HTTP on the local network only; nothing goes to the internet.
// Included by soundmesh.cpp (needs Ring, Log, g_running, g_rate).

static const char kWebPage[] = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SoundMesh</title>
<style>
:root{color-scheme:dark}body{margin:0;font:17px system-ui,sans-serif;background:#10141c;color:#e8ecf3;
display:flex;min-height:100vh;align-items:center;justify-content:center}
main{width:min(420px,92vw);text-align:center}h1{font-size:22px;margin:0 0 4px}p{color:#9aa4b5;margin:6px 0 18px}
button{width:180px;height:180px;border-radius:50%;border:0;background:#2b6cd6;color:#fff;font-size:22px;font-weight:600}
button.on{background:#1f8f55}label{display:block;text-align:left;margin:22px 0 4px;color:#9aa4b5;font-size:15px}
input{width:100%}#k{display:flex;justify-content:center;gap:14px;margin-top:22px}
#k a{width:64px;height:52px;line-height:52px;border-radius:14px;background:#1e2533;font-size:24px;cursor:pointer;user-select:none}
#k a:active{background:#2b6cd6}#st{margin-top:18px;min-height:1.4em}small{color:#6b7587;display:block;margin-top:22px;line-height:1.5}
</style></head><body><main>
<h1>SoundMesh</h1><p>Plays this PC's sound on this phone</p>
<button id="b">Play</button><div id="st"></div>
<div id="k"><a data-k="prev">&#9198;</a><a data-k="playpause">&#9199;</a><a data-k="next">&#9197;</a></div>
<small style="margin-top:6px">These control what plays on the PC</small>
<label>Volume <span id="vv">100%</span></label><input id="v" type="range" min="0" max="150" value="100">
<label>Delay <span id="dv">120 ms</span>  <small style="color:#6b7587">lower = less lag, raise if choppy</small></label><input id="d" type="range" min="40" max="1500" step="10" value="120">
<small>Keep this page open. iPhone: turn the silent switch off.</small>
</main><script>
var ctx,gain,ws,next=0,rate=48000,on=false,t0=0;
var $=function(i){return document.getElementById(i)},el,key=function(k){if(ws&&ws.readyState==1)ws.send('key:'+k)};
document.querySelectorAll('#k a').forEach(function(a){a.onclick=function(){key(a.dataset.k)}});
if('mediaSession' in navigator){var ms=navigator.mediaSession;try{ms.metadata=new MediaMetadata({title:'Sound from your PC',artist:'SoundMesh'});
 ms.setActionHandler('play',function(){key('playpause')});ms.setActionHandler('pause',function(){key('playpause')});
 ms.setActionHandler('previoustrack',function(){key('prev')});ms.setActionHandler('nexttrack',function(){key('next')})}catch(e){}}
function st(s){$('st').textContent=s}
function lat(){return $('d').value/1000}
$('v').oninput=function(){$('vv').textContent=this.value+'%';if(gain)gain.gain.value=this.value/100};
$('d').oninput=function(){$('dv').textContent=this.value+' ms';next=0;try{localStorage.d=this.value}catch(e){}};
try{if(localStorage.d){$('d').value=localStorage.d;$('dv').textContent=localStorage.d+' ms'}}catch(e){}
$('dv').textContent=$('d').value+' ms';
$('b').onclick=function(){
 if(on){on=false;if(ws)ws.close();ctx.suspend();if(el)el.pause();this.textContent='Play';this.className='';st('');return}
 if(!ctx){var C=window.AudioContext||window.webkitAudioContext;ctx=new C();gain=ctx.createGain();gain.gain.value=$('v').value/100;
  // Play through an <audio> element when possible: keeps playing with the screen off
  // and gives lock-screen controls. Falls back to plain Web Audio.
  try{var d=ctx.createMediaStreamDestination();gain.connect(d);el=new Audio();el.srcObject=d.stream;
   el.play().catch(function(){gain.disconnect();gain.connect(ctx.destination)})}catch(e){gain.connect(ctx.destination)}}
 ctx.resume();if(el)el.play().catch(function(){});on=true;this.textContent='Stop';this.className='on';connect()};
function connect(){
 if(!on)return;st('Connecting...');
 ws=new WebSocket('ws://'+location.host+'/ws');ws.binaryType='arraybuffer';
 ws.onmessage=function(e){
  if(typeof e.data==='string'){rate=JSON.parse(e.data).rate;st('Playing');return}
  var s=new Int16Array(e.data),n=s.length>>1;if(!n)return;
  var b=ctx.createBuffer(2,n,rate),L=b.getChannelData(0),R=b.getChannelData(1);
  for(var i=0;i<n;i++){L[i]=s[2*i]/32768;R[i]=s[2*i+1]/32768}
  var now=ctx.currentTime,l=lat();
  if(next<now+0.02||next>now+l+0.25)next=now+l;   // start, gap or drift: re-anchor
  var src=ctx.createBufferSource();src.buffer=b;src.connect(gain);src.start(next);next+=n/rate};
 ws.onclose=function(){if(on){st('PC not reachable - retrying...');setTimeout(connect,1500)}}}
</script></body></html>
)HTML";

// ---- SHA-1 + base64, just for the WebSocket handshake (RFC 6455)
static std::string Sha1(const std::string& msg) {
    uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    std::string m = msg;
    uint64_t bits = (uint64_t)msg.size() * 8;
    m += (char)0x80;
    while (m.size() % 64 != 56) m += (char)0;
    for (int i = 7; i >= 0; i--) m += (char)(bits >> (i * 8));
    auto rol = [](uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };
    for (size_t off = 0; off < m.size(); off += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++)
            w[i] = (uint32_t)(uint8_t)m[off + 4 * i] << 24 | (uint32_t)(uint8_t)m[off + 4 * i + 1] << 16 |
                   (uint32_t)(uint8_t)m[off + 4 * i + 2] << 8 | (uint32_t)(uint8_t)m[off + 4 * i + 3];
        for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            uint32_t t = rol(a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol(b, 30); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    std::string out;
    for (uint32_t v : h) for (int i = 3; i >= 0; i--) out += (char)(v >> (i * 8));
    return out;
}

static std::string Base64(const std::string& in) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    for (; i + 2 < in.size(); i += 3) {
        uint32_t v = (uint8_t)in[i] << 16 | (uint8_t)in[i + 1] << 8 | (uint8_t)in[i + 2];
        out += t[v >> 18]; out += t[(v >> 12) & 63]; out += t[(v >> 6) & 63]; out += t[v & 63];
    }
    if (i + 1 == in.size()) {
        uint32_t v = (uint8_t)in[i] << 16;
        out += t[v >> 18]; out += t[(v >> 12) & 63]; out += "==";
    } else if (i + 2 == in.size()) {
        uint32_t v = (uint8_t)in[i] << 16 | (uint8_t)in[i + 1] << 8;
        out += t[v >> 18]; out += t[(v >> 12) & 63]; out += t[(v >> 6) & 63]; out += '=';
    }
    return out;
}

// ---- server
struct WebClient {
    SOCKET s;
    bool ws;          // WebSocket page client; else raw WAV stream
    bool hello;       // sent the {"rate":...} message / WAV header
};

struct WebOut {
    std::atomic<bool> active{false};
    std::atomic<bool> remoteKeys{true};  // phones may press play/pause/next/previous on this PC
    int port = 4011;
    SOCKET listener = INVALID_SOCKET;
    Ring ring;
    CRITICAL_SECTION lock;
    std::vector<WebClient> clients;
    std::atomic<int> nClients{0};
    HANDLE acceptThread = nullptr, sendThread = nullptr;
    WebOut() { InitializeCriticalSection(&lock); }
};
static WebOut* g_web = nullptr;  // created once, never freed (the capture thread may read it)

static bool SendAll(SOCKET s, const char* p, int n) {
    while (n > 0) {
        int k = send(s, p, n, 0);
        if (k <= 0) return false;
        CountSocket(s, (uint64_t)k);
        p += k;
        n -= k;
    }
    return true;
}

static std::string Header(const std::string& req, const char* name) {
    std::string l = Lower(req), key = "\r\n" + Lower(name) + ":";
    size_t p = l.find(key);
    if (p == std::string::npos) return std::string();
    p += key.size();
    size_t e = req.find("\r\n", p);
    std::string v = req.substr(p, e - p);
    while (!v.empty() && isspace((unsigned char)v.front())) v.erase(v.begin());
    while (!v.empty() && isspace((unsigned char)v.back())) v.pop_back();
    return v;
}

static void HandleHttp(SOCKET c) {
    DWORD tmo = 2000;
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof(tmo));
    std::string req;
    char buf[2048];
    while (req.find("\r\n\r\n") == std::string::npos && req.size() < 8192) {
        int n = recv(c, buf, sizeof(buf), 0);
        if (n <= 0) { closesocket(c); return; }
        CountSocket(c, (uint64_t)n);
        req.append(buf, n);
    }
    std::string path;
    if (req.rfind("GET ", 0) == 0) path = req.substr(4, req.find(' ', 4) - 4);
    size_t q = path.find('?');
    if (q != std::string::npos) path.resize(q);

    DWORD stmo = 300;  // a phone that stops reading gets dropped instead of stalling everyone
    BOOL nodelay = TRUE;
    std::string key = Header(req, "Sec-WebSocket-Key");
    if (path == "/ws" && !key.empty()) {
        std::string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Accept: " + Base64(Sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")) + "\r\n\r\n";
        if (!SendAll(c, resp.data(), (int)resp.size())) { closesocket(c); return; }
        setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, (const char*)&stmo, sizeof(stmo));
        setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char*)&nodelay, sizeof(nodelay));
        EnterCriticalSection(&g_web->lock);
        g_web->clients.push_back(WebClient{c, true, false});
        g_web->nClients = (int)g_web->clients.size();
        LeaveCriticalSection(&g_web->lock);
        Log("  phone/browser connected (%d listening)\n", g_web->nClients.load());
    } else if (path == "/stream.wav") {
        const char* h = "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        if (!SendAll(c, h, (int)strlen(h))) { closesocket(c); return; }
        setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, (const char*)&stmo, sizeof(stmo));
        EnterCriticalSection(&g_web->lock);
        g_web->clients.push_back(WebClient{c, false, false});
        g_web->nClients = (int)g_web->clients.size();
        LeaveCriticalSection(&g_web->lock);
        Log("  WAV stream client connected\n");
    } else if (path == "/" || path == "/index.html") {
        std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-cache\r\n"
                           "Connection: close\r\nContent-Length: " + std::to_string(sizeof(kWebPage) - 1) + "\r\n\r\n" + kWebPage;
        SendAll(c, resp.data(), (int)resp.size());
        shutdown(c, SD_SEND);
        closesocket(c);
    } else {
        const char* r = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        SendAll(c, r, (int)strlen(r));
        closesocket(c);
    }
}

// Media keys pressed on the phone page. Only these three exist - the page
// cannot send anything else to this PC.
static void PressMediaKey(const std::string& cmd) {
    WORD vk = cmd == "playpause" ? VK_MEDIA_PLAY_PAUSE : cmd == "next" ? VK_MEDIA_NEXT_TRACK : cmd == "prev" ? VK_MEDIA_PREV_TRACK : 0;
    if (!vk || !g_web->remoteKeys) return;
    INPUT in[2] = {};
    in[0].type = INPUT_KEYBOARD;
    in[0].ki.wVk = vk;
    in[1] = in[0];
    in[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, in, sizeof(INPUT));
    Log("  phone pressed %s\n", cmd == "playpause" ? "play/pause" : cmd.c_str());
}

// One (small) WebSocket frame from a phone. Returns false when the phone is gone.
static bool ReadClientFrame(SOCKET s) {
    uint8_t b[512];
    int n = recv(s, (char*)b, sizeof(b), 0);
    if (n <= 0) return false;
    CountSocket(s, (uint64_t)n);
    if (n < 6) return true;
    int op = b[0] & 0x0F, len = b[1] & 0x7F, off = 2;
    if (op == 0x8) return false;  // close
    if (len >= 126 || !(b[1] & 0x80) || off + 4 + len > n) return true;  // not a short masked frame: ignore
    const uint8_t* mask = b + off;
    std::string msg;
    for (int i = 0; i < len; i++) msg += (char)(b[off + 4 + i] ^ mask[i & 3]);
    if (op == 0x1 && msg.rfind("key:", 0) == 0) PressMediaKey(msg.substr(4));
    return true;
}

static DWORD WINAPI WebAcceptThread(LPVOID) {
    while (g_web->active) {
        fd_set fs;
        FD_ZERO(&fs);
        FD_SET(g_web->listener, &fs);
        std::vector<SOCKET> ws;
        EnterCriticalSection(&g_web->lock);
        for (auto& c : g_web->clients)
            if (c.ws && ws.size() < FD_SETSIZE - 1) ws.push_back(c.s);
        LeaveCriticalSection(&g_web->lock);
        for (SOCKET c : ws) FD_SET(c, &fs);
        timeval tv = {0, 300000};
        if (select(0, &fs, nullptr, nullptr, &tv) <= 0) continue;
        for (SOCKET c : ws) {
            if (!FD_ISSET(c, &fs) || ReadClientFrame(c)) continue;
            EnterCriticalSection(&g_web->lock);  // phone closed the page
            for (size_t i = 0; i < g_web->clients.size(); i++)
                if (g_web->clients[i].s == c) {
                    closesocket(c);
                    g_web->clients.erase(g_web->clients.begin() + i);
                    g_web->nClients = (int)g_web->clients.size();
                    Log("  phone/browser left (%d listening)\n", (int)g_web->clients.size());
                    break;
                }
            LeaveCriticalSection(&g_web->lock);
        }
        if (!FD_ISSET(g_web->listener, &fs)) continue;
        sockaddr_in peer = {};
        int len = sizeof(peer);
        SOCKET c = accept(g_web->listener, (sockaddr*)&peer, &len);
        if (c == INVALID_SOCKET) continue;
        if (!IsLocalAddr(peer.sin_addr)) {  // only devices on this network may listen
            char ip[32];
            inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));
            Log("  refused a connection from %s (not on your local network)\n", ip);
            closesocket(c);
            continue;
        }
        HandleHttp(c);
    }
    return 0;
}

static DWORD WINAPI WebSendThread(LPVOID) {
    uint64_t R = g_web->ring.w.load(std::memory_order_acquire);
    std::vector<char> frame;
    while (g_web->active) {
        Sleep(20);
        const uint64_t W = g_web->ring.w.load(std::memory_order_acquire);
        const uint32_t rate = g_rate;
        if (W - R > rate / 2) R = W - rate / 10;  // nobody read for a while: skip to now
        uint32_t n = (uint32_t)std::min<uint64_t>(W - R, 8192);
        if (!n) continue;

        // One WebSocket binary frame of 16-bit stereo PCM (server frames are unmasked).
        const uint32_t bytes = n * 4;
        frame.resize(10 + bytes);
        size_t hdr = 0;
        frame[hdr++] = (char)0x82;
        if (bytes < 126) frame[hdr++] = (char)bytes;
        else { frame[hdr++] = 126; frame[hdr++] = (char)(bytes >> 8); frame[hdr++] = (char)bytes; }
        int16_t* pcm = (int16_t*)(frame.data() + 10);  // filled at offset 10, moved below
        for (uint32_t i = 0; i < n; i++) {
            const uint64_t k = ((R + i) & Ring::kMask) * 2;
            for (int c = 0; c < 2; c++) {
                float v = g_web->ring.buf[k + c] * 32767.0f;
                v = v > 32767.0f ? 32767.0f : (v < -32768.0f ? -32768.0f : v);
                pcm[2 * i + c] = (int16_t)lrintf(v);
            }
        }
        R += n;
        g_web->ring.r.store(R, std::memory_order_release);
        if (hdr != 10) memmove(frame.data() + hdr, frame.data() + 10, bytes);
        const char* raw = frame.data() + hdr;  // the bare PCM, for WAV clients

        EnterCriticalSection(&g_web->lock);
        for (size_t i = 0; i < g_web->clients.size();) {
            WebClient& c = g_web->clients[i];
            bool ok = true;
            if (!c.hello) {
                if (c.ws) {
                    std::string j = "{\"rate\":" + std::to_string(rate) + "}";
                    char h[2] = {(char)0x81, (char)j.size()};
                    ok = SendAll(c.s, h, 2) && SendAll(c.s, j.data(), (int)j.size());
                } else {
                    uint8_t w[44];
                    auto u32 = [&](int o, uint32_t v) { for (int b = 0; b < 4; b++) w[o + b] = (uint8_t)(v >> (8 * b)); };
                    memcpy(w, "RIFF", 4); u32(4, 0x7FFFF024); memcpy(w + 8, "WAVEfmt ", 8); u32(16, 16);
                    w[20] = 1; w[21] = 0; w[22] = 2; w[23] = 0; u32(24, rate); u32(28, rate * 4);
                    w[32] = 4; w[33] = 0; w[34] = 16; w[35] = 0; memcpy(w + 36, "data", 4); u32(40, 0x7FFFF000);
                    ok = SendAll(c.s, (const char*)w, 44);
                }
                c.hello = true;
            }
            if (ok) ok = c.ws ? SendAll(c.s, frame.data(), (int)(hdr + bytes)) : SendAll(c.s, raw, (int)bytes);
            if (!ok) {
                closesocket(c.s);
                g_web->clients.erase(g_web->clients.begin() + i);
                Log("  phone/browser left (%d listening)\n", (int)g_web->clients.size());
                continue;
            }
            i++;
        }
        g_web->nClients = (int)g_web->clients.size();
        LeaveCriticalSection(&g_web->lock);
    }
    return 0;
}

static bool StartWeb(int port) {
    if (!g_web) g_web = new WebOut();
    if (g_web->active) return true;
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in a = {};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(s, (sockaddr*)&a, sizeof(a)) != 0 || listen(s, 8) != 0) {
        Log("! cannot open TCP port %d for phones (error %d) - is another SoundMesh running?\n", port, WSAGetLastError());
        closesocket(s);
        return false;
    }
    g_web->port = port;
    g_web->listener = s;
    g_web->ring.r.store(g_web->ring.w.load());
    g_web->active = true;
    g_web->acceptThread = CreateThread(nullptr, 0, WebAcceptThread, nullptr, 0, nullptr);
    g_web->sendThread = CreateThread(nullptr, 0, WebSendThread, nullptr, 0, nullptr);
    return true;
}

static void StopWeb() {
    if (!g_web || !g_web->active) return;
    g_web->active = false;
    for (HANDLE* t : {&g_web->acceptThread, &g_web->sendThread})
        if (*t) { WaitForSingleObject(*t, 3000); CloseHandle(*t); *t = nullptr; }
    closesocket(g_web->listener);
    EnterCriticalSection(&g_web->lock);
    for (auto& c : g_web->clients) closesocket(c.s);
    g_web->clients.clear();
    g_web->nClients = 0;
    LeaveCriticalSection(&g_web->lock);
}

// This PC's addresses on real (non-virtual) adapters, Wi-Fi first.
struct LocalIp {
    std::string ip, adapter;
    bool wifi;
};
static std::vector<LocalIp> LocalIPv4s() {
    std::vector<LocalIp> out;
    ULONG len = 32 * 1024;
    std::vector<char> buf(len);
    auto* aa = (IP_ADAPTER_ADDRESSES*)buf.data();
    if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, aa, &len) ==
        ERROR_BUFFER_OVERFLOW) {
        buf.resize(len);
        aa = (IP_ADAPTER_ADDRESSES*)buf.data();
        if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, aa, &len))
            return out;
    }
    for (auto* a = aa; a; a = a->Next) {
        if (a->OperStatus != IfOperStatusUp || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
        std::string desc = Lower(Utf8(a->Description ? a->Description : L"")) + " " + Lower(Utf8(a->FriendlyName ? a->FriendlyName : L""));
        bool skip = false;
        for (const char* v : {"virtual", "vmware", "hyper-v", "vethernet", "loopback", "bluetooth", "wsl", "tap-", "vpn", "tunnel"})
            skip |= desc.find(v) != std::string::npos;
        if (skip) continue;
        for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
            auto* sin = (sockaddr_in*)u->Address.lpSockaddr;
            if (sin->sin_family != AF_INET) continue;
            char ip[32];
            inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
            if (strncmp(ip, "169.254.", 8) == 0 || strncmp(ip, "127.", 4) == 0) continue;
            out.push_back(LocalIp{ip, Utf8(a->FriendlyName ? a->FriendlyName : L""), a->IfType == IF_TYPE_IEEE80211});
        }
    }
    std::stable_sort(out.begin(), out.end(), [](const LocalIp& x, const LocalIp& y) { return x.wifi > y.wifi; });
    return out;
}

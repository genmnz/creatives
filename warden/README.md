# Warden

A personal Android privacy app for a Samsung phone. It blocks telemetry and location tracking, and keeps your settings the way you set them when a SIM or eSIM tries to change them. It can also report a spot you pick on a map as your location.

- **Tiny:** a 66 KB APK. Plain Java on the Android framework, no libraries, no AndroidX, no Kotlin.
- **No servers:** there is no Warden server. Lists live on the phone. Allowed lookups go to the DNS server your Wi-Fi or carrier already gives you. The only other connection is map tiles from OpenStreetMap, and only while the map screen is open.
- **Almost no battery:** only DNS goes through the app. Your downloads, video and calls never pass through it. When nothing is being looked up, its two threads are asleep in `read()`/`select()`: no polling, no timers, no wakelocks. Answers are cached, so repeated lookups don't wake the radio.

## What it does

| Feature | How |
|---|---|
| **Block telemetry & trackers** | A local VPN that carries only DNS. Blocked names get `0.0.0.0`. The built-in lists cover Google/Firebase analytics, crash reporters, attribution SDKs, Microsoft, Unity, Samsung diagnostics/ads and other phone makers. Apps that hardcode Google/Cloudflare/Quad9/OpenDNS/AdGuard DNS are caught too, and their DNS-over-HTTPS is refused so they fall back to normal DNS, which Warden filters. |
| **Block location lookups** | A *Location services* list blocks the servers that turn your nearby Wi-Fi and cell towers into a position: SUPL/A-GPS, Qualcomm XTRA, Broadcom LTO, Mozilla/HERE/Combain/Skyhook, IP-geolocation APIs. GPS still works; the first fix outdoors just takes longer. |
| **Report a marked spot** | Pick a point on the map (or type coordinates). Warden replaces the GPS and network location providers with that point, with a little sub-metre jitter, so apps only see your marked spot. |
| **Settings lock (SIM / eSIM)** | Tick a setting to keep its current value: automatic date & time, time zone, 12/24 h, date format, roaming, Wi-Fi/Bluetooth scanning, A-GPS, or any `global:`/`secure:`/`system:` key. If anything changes it (carrier customisation, network time, Samsung's OMC agent), Warden puts it back right away and checks again 2 s, 15 s, 1 min and 3 min after every SIM change. |
| **Your own lists** | *Recent lookups* shows what the phone asked for; tap a name to block it, or to allow it if it was blocked. *Edit my lists* opens your personal block and allow lists. *Import list file* takes any hosts file, plain domain list or `||domain^` adblock list from your storage. This is also how you can add ad blocking now, before the built-in ads list arrives in the next patch. |
| **Stays on** | Starts again at boot and after updates. Works with Android's *Always-on VPN* (leave *Block connections without VPN* off). Optional device admin protects it from being removed by accident. |

## Install (once)

1. Copy `dist/Warden.apk` to the phone and open it. Allow *Install unknown apps* for your file manager when asked.
2. Open **Warden**, turn on **Block telemetry & trackers**, and accept the VPN prompt.
3. **Settings → Connections → More connection settings → Private DNS → Off.** If Private DNS is set to a hostname, Android sends DNS straight there and Warden never sees it. The app warns you if it's on.
4. In Warden → *Keep running*:
   - **Always-on VPN** → gear next to Warden → turn on *Always-on VPN*. Leave *Block connections without VPN* **off**: Warden only carries DNS, so that option would cut off all other traffic.
   - **Battery: unrestricted** → *Allow*. Also Settings → Apps → Warden → Battery → **Unrestricted**. Samsung's "deep sleeping apps" will otherwise kill it.
   - **Device admin** → *Activate*. Optional.
5. **One-time adb step** for the settings lock and location (5 minutes):
   1. Enable Developer options: Settings → About phone → Software information → tap *Build number* 7×.
   2. Developer options → **USB debugging** on.
   3. On the PC, install [Android platform-tools](https://developer.android.com/tools/releases/platform-tools), plug in the phone, and accept the prompt on the phone.
   4. Run `tools/adb-setup.cmd` (Windows) or `tools/adb-setup.sh` (Mac/Linux).

   This grants `WRITE_SECURE_SETTINGS`, makes Warden the mock location app, allows *Modify system settings* and exempts it from Doze. Android only grants these through adb; no root is needed. They survive reboots and app updates, but not an uninstall.

   Without adb you can still lock System keys (*Allow system settings* button) and choose Warden in Developer options → *Select mock location app*.

## Stop the SIM from re-customising the phone

When a SIM or eSIM is detected, Samsung's **OMC agent** applies carrier settings. Two layers handle this:

1. **Settings lock:** set the date, time, time zone and so on the way you want in Settings, then tick them in Warden. Anything the carrier flips gets reverted at once.
2. **Disable the agent** (optional, reversible): `tools/samsung-debloat.cmd` / `.sh` disables `omcagent` and a few Samsung/Facebook telemetry packages listed in `tools/samsung-packages.txt`. Edit the list first if you want to keep something. Run it with `--undo` to bring everything back; a factory reset also restores them.

## Limits (honest)

- **Encrypted DNS inside apps:** an app that ships its own DNS-over-HTTPS to a server not on the "caught" list bypasses any DNS filter, Warden included. Chrome only does this if you turn on *Use secure DNS* with a custom provider, so leave that off.
- **Google Play services** location uses `www.googleapis.com`, which also runs half of Android. It can't be blocked by name without breaking things. The location list blocks what can be blocked safely; the marked-spot feature covers the rest.
- **Mock location can be detected** by apps that check for it (some banking and game apps). They see a location flagged as "mock".
- **Only one VPN at a time:** another VPN app turns Warden's DNS filter off. The settings lock and location keep working.
- **"Optimises itself"** in practice means it does no work unless something happens. There are no background loops to tune. The answer cache drops itself when Android is low on memory, and it is cleared on every network change, because answers can differ per network.

## Build it yourself

You need JDK 17+ and the Android SDK (platform 35). Then:

```sh
tools/build.sh        # runs the tests, creates your signing key once (warden.jks), builds dist/Warden.apk
```

- **Keep `warden.jks`.** Android only installs an update over the old app if both are signed with the same key. The key is gitignored, because this repo is public.
- The APK in `dist/` was signed with a key that is gone now. When you first install your own build, uninstall that one first.
- `tools/test.sh` runs the desktop tests for the packet, DNS and blocklist code.

## How it works

```
apps → system resolver → 10.111.222.1 (fake DNS, routed into the VPN)
                                │
                     Warden reads the DNS packet
                 ┌──────────────┼───────────────┐
             on a list        in cache         otherwise
             0.0.0.0        cached answer   forward to the network's
                                             own DNS, cache, reply
all other traffic ──────────────────────────► straight to Wi-Fi / mobile (never enters Warden)
```

- `Engine.java`: VPN, DNS forwarding, cache, network and SIM watching.
- `Packets.java`: IPv4/IPv6/UDP/TCP/DNS building and parsing.
- `Blocklist.java` / `Store.java`: lists compiled to a sorted array of 64-bit hashes (8 bytes per domain).
- `Guard.java`: settings lock.
- `Spoofer.java`: marked spot.
- `MapActivity.java`: the map, about 200 lines.
- `app/src/main/assets/lists/`: the built-in lists, plain text.

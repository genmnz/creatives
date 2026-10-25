# Melad

A personal, all-in-one privacy toolbox for an Android (Samsung) phone. One app, everything on the device:

- **Blocks** ads, trackers and telemetry with a local DNS filter — no outside servers of its own.
- **Blocks location lookups** and can **report a spot you pick on a map** as the phone's location.
- **Locks your settings** so a SIM/eSIM or carrier update can't quietly change the date, time zone, roaming and so on.
- **Recognises cheap earbuds** that have no companion app, shows their battery, and switches game mode / noise control.

Plain Java on the bare Android framework. No libraries, no AndroidX, no Kotlin, no account, no analytics.

- **Light:** the code is tiny and does nothing while idle — its threads sleep in `read()`/`select()`, no polling, no wakelocks. The APK is ~640 KB, almost all of which is the bundled blocklist (71k domains); the program itself is a few tens of KB.
- **No servers of ours:** blocklists live on the phone. Allowed DNS lookups go to the resolver your Wi-Fi/carrier already gives you. The only outside connections are: downloading blocklist updates (optional, from public list projects), and OpenStreetMap tiles while the map is open.

## What it does

| Feature | How |
|---|---|
| **Block ads, trackers & telemetry** | A local VPN that carries only DNS. Blocked names get `0.0.0.0`; everything else goes straight out, so there's no per-packet cost on downloads or video. Apps that hardcode Google/Cloudflare/Quad9/OpenDNS/AdGuard DNS are caught too, and their DNS-over-HTTPS is refused so they fall back to normal DNS, which Melad filters. |
| **Choose your lists** | Categories you tick on/off: *Ads/trackers/telemetry*, *Location lookups*, *Device & carrier trackers*, *Block encrypted-DNS bypass*, *Stronger blocking*, *Annoyances & pop-ups*. See **Where the lists come from** below. |
| **Block location lookups** | A list of the servers that turn nearby Wi-Fi/cell towers into a position: SUPL/A-GPS, Qualcomm XTRA, Broadcom LTO, Mozilla/HERE/Combain/Skyhook, IP-geolocation APIs. GPS still works; first fix outdoors just takes longer. |
| **Report a marked spot** | Pick a point on the map (or type coordinates). Melad replaces the GPS and network providers with that point (with a little sub-metre jitter) so apps only see your marked spot. |
| **Settings lock (SIM / eSIM)** | Tick a setting to keep its value: automatic date & time, time zone, 12/24h, date format, roaming, Wi-Fi/Bluetooth scanning, A-GPS, or any `global:`/`secure:`/`system:` key. If anything changes it (carrier customisation, network time, Samsung's OMC agent), Melad puts it back at once and re-checks 2 s / 15 s / 1 min / 3 min after every SIM change. |
| **My earbuds** | See below. |
| **Your own lists** | *Recent lookups* shows what the phone asked for; tap a name to block or allow it. *Edit my lists* holds your personal block/allow lists. *Import list file* takes any hosts file, domain list or `||domain^` adblock list. |
| **Clear active/inactive sign** | A coloured banner at the top: green "Protecting" (with what's on), amber "Starting…", grey "Off". |
| **Stays on** | Restarts at boot and after updates. Works with Android's *Always-on VPN* (leave *Block connections without VPN* off). Optional device admin stops accidental removal. |

## Where the lists come from

Like uBlock Origin or AdGuard, Melad uses public, community-maintained blocklists — the same kind you saw in uBlock's settings ("EasyList", "annoyances", etc.). It ships with an up-to-date copy of each inside the app so it works offline out of the box, and can refresh them:

- **Ads, trackers & telemetry** — [HaGeZi Multi Light](https://github.com/hagezi/dns-blocklists) (~71k domains). A size-optimised, low-breakage set covering ads, analytics, metrics and telemetry across apps and the web.
- **Device & carrier trackers** — HaGeZi native-tracker lists for Samsung, Xiaomi, Apple, Amazon, Microsoft and TikTok.
- **Block encrypted-DNS bypass** — HaGeZi DNS-bypass list (public DoH servers), so apps can't tunnel around the filter.
- **Stronger blocking** — HaGeZi Multi Pro (bigger, more aggressive). Downloaded on first use.
- **Annoyances & pop-ups** — AdGuard/HaGeZi pop-up list. Downloaded on first use.
- **Location lookups** — a hand-made list (there's no standard one for this).

Lists are mirrored on Codeberg and GitLab so no single host is required. HaGeZi's lists are **CC0** (public domain). **Update lists now** refreshes them on demand; **Auto-update** does it about once a day when you're on Wi-Fi. An update only downloads the list text — nothing about you is sent.

The old built-in hand-written lists from v1.0 are gone; these community lists are broader and keep themselves current.

## My earbuds

For cheap/clone TWS earbuds that Samsung Wearables and Galaxy Buds apps don't recognise and that have no companion app of their own. Open **My earbuds**:

- **Battery, no pairing:** a quick Bluetooth scan reads left/right/case battery straight from the earbuds' advertisement, for buds that broadcast it in the **Apple (AirPods-style)** or **Xiaomi** format — which most clones copy to get the pairing pop-up. Works with the case open.
- **Chip recognition:** when you connect, Melad reads the Bluetooth services and the maker ID and tells you the chip family (JieLi, Airoha, Bestechnic, Bluetrum, Qualcomm, Realtek, Actions, Beken, WuQi…). That tells you what's controllable.
- **JieLi earbuds (very common in clones):** Melad speaks their native **RCSP** protocol over Bluetooth LE (service `AE00`), including the authentication handshake. Then it shows **live battery** (even in-ear) and lets you switch **game mode (low latency)**, **microphone channel**, and **noise control / transparency** when the firmware supports them. Values you can't change aren't shown.

How to use it: pair the earbuds once in Settings → Bluetooth, then open **My earbuds** and tap them in the list. Grant *Nearby devices* when asked.

**Honest limits.** Reading the advertisement works for many clones but not all — some broadcast nothing useful, and then battery only shows after a JieLi connect. Live control is implemented for **JieLi** chips; other chips are recognised and show battery (via scan) but aren't controlled yet. This talks to whatever firmware your buds actually run, so a given model may expose more or fewer controls than another. Nothing here can brick the buds — it only sends the same commands the official apps do — but these are clones, so treat it as best-effort. Which of your 4+ earbuds are JieLi will show the moment you connect each one.

## Install (once)

1. Copy `dist/Melad.apk` to the phone and open it. Allow *Install unknown apps* for your file manager when asked. (If v1.0 "Warden" is installed, this updates it in place — same signing key.)
2. Open **Melad**, turn on **Block ads, trackers & telemetry**, accept the VPN prompt.
3. **Settings → Connections → More → Private DNS → Off.** If Private DNS points at a hostname, Android sends DNS there directly and Melad never sees it. The app warns you if it's on.
4. In Melad → *Keep running*:
   - **Always-on VPN** → gear next to Melad → turn on *Always-on VPN*. Leave *Block connections without VPN* **off** (Melad carries only DNS; that option would cut all other traffic).
   - **Battery: unrestricted** → *Allow*, and Settings → Apps → Melad → Battery → **Unrestricted**. Samsung's "deep sleeping apps" will otherwise kill it.
   - **Device admin** → *Activate*. Optional.
5. **One-time adb step** for the settings lock and location (5 minutes), over USB with *USB debugging* on: run `tools/adb-setup.cmd` (Windows) or `tools/adb-setup.sh` (Mac/Linux). It grants `WRITE_SECURE_SETTINGS`, makes Melad the mock-location app, allows *Modify system settings* and exempts it from Doze. No root needed.

## Stop the SIM from re-customising the phone

1. **Settings lock:** set the date, time, time zone etc. the way you want in Settings, then tick them in Melad. Anything the carrier flips gets reverted at once.
2. **Disable Samsung's agent** (optional, reversible): `tools/samsung-debloat.cmd` / `.sh` disables `omcagent` and some Samsung/Facebook telemetry packages listed in `tools/samsung-packages.txt`. Run with `--undo` to restore; a factory reset also restores them.

## Build it yourself

JDK 17+ and the Android SDK (platform 35). Then:

```sh
tools/build.sh        # runs the tests, creates your signing key once (warden.jks), builds dist/Melad.apk
```

- **Keep the signing key.** Android only installs an update over the old app if both are signed with the same key. It's gitignored (this repo is public).
- `tools/test.sh` runs the desktop tests for the packet/DNS/blocklist code **and** the earbud protocols (JieLi auth known-answer vectors, RCSP framing, advertisement parsing) — needs only a JDK.

## How it works

- `Engine.java` — the VPN DNS filter, cache, network/SIM watching, and the once-a-day list auto-update.
- `Packets.java` — IPv4/IPv6/UDP/TCP/DNS building and parsing.
- `Blocklist.java` / `Store.java` / `Updater.java` — lists compiled to a sorted array of 64-bit hashes (8 bytes/domain), the list catalogue, and the downloader.
- `Guard.java` — the settings lock. `Spoofer.java` — the marked spot. `MapActivity.java` — the map.
- `Earbuds.java` — chip recognition, battery parsing, and the JieLi RCSP protocol (pure Java, unit-tested). `JlAuth.java` — the JieLi auth cipher. `EarbudLink.java` — the Bluetooth LE connection. `EarbudsActivity.java` — the earbuds screen.

### Credits for the earbud protocols

Recognition and control were built from public, open-source reverse-engineering. The JieLi auth cipher is a Java port of `auth.py` from **ElectronicCats/jieli-ble-badge-research** (MIT). The JieLi RCSP framing, battery push and settings opcodes were cross-checked against **Jieli-Tech/Android-JL_Bluetooth** (JieLi's own SDK) and the Redmi Buds notes in **Neisvestney/buds-sniffer**. Advertisement battery parsing follows the **OpenPods** project (Apple format) and the Xiaomi notes above. Chip and company IDs come from the Bluetooth SIG and IEEE registries.

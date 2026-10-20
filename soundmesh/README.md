# SoundMesh

Play the same sound on several Bluetooth headphones, speakers and other computers at the same time, from a Windows 11 PC.

- **One portable `.exe`** (~220 KB). Nothing to install, no driver, no admin rights, no dependencies.
- **Fast and light:** native C++ with WASAPI and real-time audio threads, about 5–10 MB of RAM.
- **Fan-out:** one source goes to any number of outputs. Each output has its own buffer, clock-drift correction and adjustable delay, so different headphones stay in sync.
- **Any route:**
  - Sources: what the PC is playing (loopback), a microphone, or a LAN stream.
  - Outputs: Bluetooth or USB headphones, speakers, HDMI, or other devices on the LAN.
- **Never uses the internet:** LAN packets are sent with TTL 1, so routers cannot forward them to the internet. They stay on your home network and do not count against your data quota.
- **Scream-compatible network audio:** existing [Scream](https://github.com/duncanthrax/scream) receivers (Windows, Linux, Android, Raspberry Pi) can play SoundMesh's stream. Scream needs a kernel driver to send; SoundMesh sends from user mode.

## Quick start

1. Pair every headphone in **Settings → Bluetooth & devices** (or run `soundmesh bt`). Turn them all on.
2. Double-click `soundmesh.exe` and answer three questions:

```
Playback devices (outputs, and loopback sources):
  [1] Speakers (Realtek(R) Audio)   <- Windows default
  [2] Headphones (WH-1000XM4)
  [3] Headphones (AirPods Pro)
  [4] Headset (AirPods Pro Hands-Free)   (Bluetooth call mode: low quality, avoid)

Source? [Enter = what the Windows default device plays | loop:N | mic:N | net]:     <Enter>
Play on which devices? 2,3
Also send over the LAN? [Enter = no | m = multicast | IPs, comma separated]:       <Enter>
```

Everything Windows plays (YouTube, Spotify, games) now also plays on both headphones.

Commands while it runs:

| Type | Does |
|---|---|
| `s` | status: buffer level, delay, volume and dropouts for each output |
| `d 3 120` | delay output 3 by 120 ms (to line up headphones) |
| `v 2 70` | set output 2 to 70 % volume |
| `l 80` | set the base latency to 80 ms (raise it if you hear dropouts) |
| `q` | quit |

The wizard prints the matching command line at the end. Put it in a desktop shortcut to skip the questions next time.

### Command line

```
soundmesh list                                     show devices and their numbers
soundmesh --to "WH-1000,AirPods"                   default device -> 2 headphones (match by name)
soundmesh --to 2,3 --delay 3=80 --vol 2=90         by number, with lip-sync delay and volume
soundmesh --from loop:1 --to 2,3                   capture a specific playback device
soundmesh --from mic:1 --to 2,3                    microphone -> headphones (e.g. a TV-assist setup)
soundmesh --to 2 --net 192.168.1.23,192.168.1.40   headphone + two other devices on the LAN
soundmesh --from net --to 2,3                      receive from another PC and play on local headphones
```

Device numbers can change when devices connect or disconnect. Names (or any part of a name) are more reliable.

## Which device is the "source"?

Loopback captures what Windows plays on the **default** playback device, and that device keeps playing the sound too. SoundMesh refuses to also send to that device, because doing so would cause an endless echo. You have two good setups:

- **Speakers as the default (recommended):** set the laptop speakers as the Windows default, turn their volume down, and send to all headphones with `--to 2,3`. Every headphone then goes through SoundMesh, so all of them can be synced with `d N MS`. On most PCs the captured sound does not depend on the speaker volume slider. If yours goes silent, use any spare output (such as HDMI with no monitor attached) as the default instead.
- **Headphone 1 as the default:** headphone 1 plays natively with the lowest latency, and SoundMesh mirrors to the others. You can only delay the mirrored ones.

## Bluetooth: limits

- **2 headphones work well on almost every PC, and 3 work on many.** Windows uses only **one** Bluetooth radio at a time, and every A2DP stream shares it. Past that point, extra headphones stutter no matter what software you use. To go beyond the limit, run SoundMesh on a second PC or laptop with `--from net` and pair more headphones there (see below).
- **Avoid "Hands-Free" endpoints.** Every headset shows up twice: `Headphones (X)` is stereo music quality, and `Headset (X Hands-Free)` is call mode with low quality. Opening the Hands-Free one forces the headset into call mode. SoundMesh flags these endpoints, and name matching always picks the stereo one.
- **Each Bluetooth headphone has its own built-in latency** (roughly 100–300 ms). Use `d N MS` while watching a video until lips and sound match on every headphone.
- **2.4 GHz Wi-Fi and Bluetooth share the same airwaves.** If audio crackles while the LAN is in use, put the PC on **5 GHz** Wi-Fi or Ethernet.
- Windows 11 has a "Shared audio" preview feature, but it works only with **LE Audio** headphones (a few recent models). SoundMesh works with any classic Bluetooth headphone.

## LAN outputs (other PCs, phones, Raspberry Pi), no internet needed

Audio goes over your **local** network only. The router just switches packets between devices in your home, and nothing goes to your ISP. It even works with the router's internet (WAN) cable unplugged.

**On the sending PC:**
```
soundmesh --to 2 --net 192.168.1.23            unicast to one device (best on Wi-Fi)
soundmesh --to 2 --net 192.168.1.23,192.168.1.40
soundmesh --to 2 --net multicast               one stream that every receiver picks up (best on Ethernet)
```

**On each receiver:**

| Receiver | How |
|---|---|
| Another Windows PC | `soundmesh --from net --to 2` (its own Bluetooth headphones join the group too) |
| Linux / Raspberry Pi | the Scream receiver: `scream -u -o pulse` for unicast, or `scream -o pulse` for multicast |
| Android | the Scream Android receiver (`Receivers/android` in the Scream repo) |

Bandwidth is about 1.4 Mbit/s per unicast receiver (44.1 kHz, 16-bit, stereo), which is tiny for any Wi-Fi.

### Router / modem and Windows settings

You do **not** need "media sharing", DLNA, UPnP, port forwarding or a hotspot. Check these settings:

1. **Put every device on the same network.** Use the same router and the same subnet (all addresses look like `192.168.1.x`). **Do not use the Guest Wi-Fi.** Guest networks block devices from talking to each other.
2. **Turn off AP isolation.** It is also called *Client isolation*, *Wireless isolation* or *Station isolation*, usually under Wireless → Advanced. When it is on, devices on Wi-Fi cannot reach each other.
3. **Set the Windows network to Private:** Settings → Network & internet → Wi-Fi (or Ethernet) → your network → **Private network**.
4. **Allow the firewall.** Windows asks the first time you run `--from net`. Allow it for **Private networks**. Or run this once in an admin terminal on each receiving PC:
   ```
   netsh advfirewall firewall add rule name="SoundMesh" dir=in action=allow protocol=UDP localport=4010 profile=private
   ```
5. **Give receivers fixed addresses.** In the router, under *DHCP reservation* / *Address reservation*, pin each receiver's IP so your `--net` command keeps working. Find a device's IP with `ipconfig` (Windows) or in its Wi-Fi details.
6. **Multicast only:** Over Wi-Fi, routers send multicast at the slowest rate, which often sounds choppy. Use unicast IPs on Wi-Fi. If you use multicast, enable *IGMP snooping* or *Multicast to unicast* (sometimes called *IPTV* settings) if your router has it. If the PC has several adapters (VPN, VirtualBox), pick the right one with `--iface 192.168.1.10`.
7. **No router at all?** Connect two PCs directly with an Ethernet cable. Windows gives both `169.254.x.x` addresses, and `--net multicast` works out of the box.

## How it works

```
                 +-> ring buffer -> drift-corrected resampler -> WASAPI -> Headphones A (BT)
 source -------->+-> ring buffer -> drift-corrected resampler -> WASAPI -> Headphones B (BT)
 (WASAPI loopback|-> ring buffer -> ...                                -> USB / HDMI / speakers
  / mic / UDP)   +-> 16-bit PCM, 1157-byte UDP packets (Scream format) -> LAN devices
```

- **Capture:** event-driven WASAPI shared mode, using loopback for "what you hear". It runs on an MMCSS "Pro Audio" priority thread.
- **Each output:** its own thread and a lock-free single-producer/single-consumer ring of about 2.7 s, holding `latency + delay` ms of audio.
  - Every device's clock runs at a slightly different speed, so a smoothed buffer-level controller nudges the playback rate by at most ±0.4 %. That correction is inaudible, and it means the outputs never drift apart or slowly build up delay.
  - Large jumps (a delay change, a reconnect) are applied instantly.
- **Format conversion:** Windows' own resampler (`AUTOCONVERTPCM`) converts each stream to whatever the device needs, such as the A2DP rate. Disconnected headphones are retried every 2 s and resume automatically.
- **Why there is no driver:** loopback already captures everything Windows plays, without any install. A kernel driver (the way Scream and Voicemeeter work) would need signing, admin rights and an installer, and a bug in it could crash the PC. That conflicts with "one portable exe".

## Build

On Linux, cross-compile with mingw-w64:

```
sudo apt install mingw-w64
./build.sh                 # -> dist/soundmesh.exe
```

On Windows with MSYS2, run the same `g++` line from `build.sh`.

## Tested

The build was tested in Linux under Wine with virtual PulseAudio devices:

- **Fan-out:** a 1 kHz tone was fanned out to two outputs. Both played it at the correct pitch, with full level and no clicks. Buffers held their 60 ms target with no dropouts.
- **LAN:** PC→PC over UDP played clean 440 Hz audio on the receiver.
- **Scream compatibility:** the official Scream receiver decoded SoundMesh's stream correctly.

Wine does not implement WASAPI loopback, so loopback capture still needs to be confirmed on real Windows. It uses the standard, documented API.

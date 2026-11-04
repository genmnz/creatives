# Holdfast

A small Android app (~110 KB, no internet permission) that turns off a phone's on-device location signals and **keeps them off** without root. It's built for Samsung One UI 9 / Android 17 but works on any Android 11+ phone.

- **Nothing happens without you.** Every change opens a confirm dialog that shows the current value, the value it will set, the privilege it will use, and **the exact API call or shell command** that will run. You pick the path and press the button.
- **Every change is verified.** After running, Holdfast reads the value back and reports `verified ✓`, `NOT verified ✗` (the call was accepted but didn't take, for example on a Samsung build that ignores it) or `can't be verified`.
- **Granular diagnostics.** Each control shows its current value, the wanted value, whether it's held, which path you confirmed, the last action and its verdict, how many times something changed it back (and when), and the value before Holdfast touched it. The Diagnostics screen puts all of that in one copyable plain-text report, along with privileges, where Android thinks you are, the Samsung CSC, and the full event log.
- **"…and keep it that way".** Choose this and Holdfast watches the setting. When One UI, Google Maps or a setup screen changes it back, you get a notification that shows the command; nothing runs until you tap **Fix it**. You can choose "Fix it on its own" per setting instead. That's logged, and it pauses after 3 fixes in 10 minutes so it can't fight another component forever.
- **Plain words first.** Rows say *On · tap to turn off*, *Off · Holdfast is watching it* or *needs more permission*. Commands and raw values sit under **Technical details** in every dialog.

`dist/holdfast.apk` is a ready-to-install build.

## What it controls

| Section | Control | Paths, strongest first |
|---|---|---|
| Location | Location off | Device Owner `setLocationEnabled` · Shizuku `cmd location set-location-enabled` · `location_mode` write |
| | Lock the location switch / block location sharing | Device Owner user restrictions |
| | Assisted GPS (SUPL) off | `assisted_gps_enabled` via secure-settings grant or Shizuku |
| Scanning | Wi-Fi and Bluetooth "always" scanning off | `wifi_scan_always_enabled`, `ble_scan_always_enabled` |
| | Samsung nearby device scanning off | `nearby_scanning_enabled`, `nearby_scanning_permission_allowed` (system) |
| Time zone | Automatic time zone off | Device Owner `setAutoTimeZoneEnabled` · `auto_time_zone` · `cmd time_zone_detector` |
| | Lock date & time | Device Owner `DISALLOW_CONFIG_DATE_TIME` |
| | Location-based time zone off | `location_time_zone_detection_enabled` · `cmd time_zone_detector set_geo_detection_enabled` |
| Ads & telemetry apps | Visit In, Customization Service, maps agent, OMC agent, diagmon, DQ agent, Chrome customisations (only those installed) | Device Owner **suspend** (reversible) · Shizuku `pm disable-user` |
| Network | Private DNS locked to a host you choose | Device Owner `setGlobalPrivateDnsModeSpecifiedHost` · settings write |
| Region (experimental) | SIM country override until reboot; can't be held | Shizuku `cmd phone cc set-value sim_country_iso_override_string` |
| Per-app location | Each app that asks for location / BT scan / nearby Wi-Fi | Device Owner `setPermissionGrantState(DENIED)` · Shizuku `pm revoke` + `appops … ignore` |

**Do these yourself** is a checklist for things no app can change: deleting the advertising ID, Google My Ad Center, Timeline and Web & App Activity, Samsung's ad and customisation toggles, the Meta profile city, Emergency Location Service, Find My Mobile, and wireless debugging. Each item has an **Open** button. Diagnostics reports these as self-reported.

**Turn off recommended…** lists every location, scanning and time-zone setting that's still on. Nothing is pre-ticked, and the exact commands are under Technical details.

**Put it back the way it was** restores the value recorded before Holdfast's first change and stops watching that setting.

## Setup

Install `dist/holdfast.apk`, then give it any of these. It uses whichever it holds, strongest first, and the **Setup** screen walks you through each one step by step.

1. **Device Owner** (recommended backbone; survives reboots and updates).
   - Before running the command:
     - Remove every account in Settings › Accounts. You can sign back in afterwards.
     - Delete Secure Folder, any work profile, private space, other users and Dual Messenger clones.
     - Turn **Auto Blocker** off.
     - Turn USB debugging on.
   - Then run:

```bash
adb shell dpm set-device-owner com.genmnz.holdfast/.AdminReceiver
```

2. **Secure settings grant**, for the scanning, A-GPS, time zone and DNS keys. Device Owner doesn't include this, so grant it too:

```bash
adb shell pm grant com.genmnz.holdfast android.permission.WRITE_SECURE_SETTINGS
```

3. **Modify system settings** (in-app button). Only the Samsung nearby keys need it, and Samsung may refuse those anyway; verification will tell you.
4. **Shizuku** (optional), for shell-only things: app ops, disabling packages, the time zone detector and the SIM country override. It has to be restarted after each reboot, and Holdfast keeps enforcing through tiers 1–2 meanwhile. On Android 17 QPR1+ use a fork that handles the `adb_enabled` change, such as thedjchi's Shizuku or Shizuku+.

Afterwards, turn wireless debugging off. Diagnostics warns you if the security patch is older than 2026-05-01 (CVE-2026-0073).

**Remove Device Owner** is on the Setup screen. Android then clears the restrictions and suspensions Holdfast set.

## How the watchdog works (no resident service)

- **One JobScheduler job** triggers on the content URIs of every held settings key, so it wakes within about 1–3 s of a change, even when the app isn't running.
- **A persisted 15-minute periodic job** is the backstop for things without a URI (packages, per-app permissions).
- **A boot / app-update receiver** re-checks and re-arms both jobs. It also logs a `SYSTEM-UPDATE` event when the build fingerprint changes.
- Each drift is logged and counted once per change from right to wrong. A control that stays wrong isn't recounted at every check.

## What it can't do

Without root or a VPN, these are out of reach:

- **Network country (cell MCC).** It's read first by Android's country detector.
- **Your carrier or Wi-Fi IP.** Ad platforms use it first.
- **The carrier's knowledge of your cell.**
- **Emergency network location.**

A **CSC change** is also outside the app: it needs a PC or a second phone (Test Mode AT commands), and on recent firmware (`ro.omc.changetype = DATA_RESET_ON`) it wipes the phone. Holdfast only *reads* the CSC, the change type and the bundled CSCs, in Diagnostics.

## Build

Needs JDK 17+, Gradle 8.13+ and Android SDK platform 36:

```bash
gradle assembleRelease
```

The output is `app/build/outputs/apk/release/app-release.apk`. Release builds are minified and signed with your local debug key. That key is per machine, so a build from a different machine can't update an existing install. That matters for Device Owner, which can't be uninstalled: remove Device Owner in the app first, then uninstall and reinstall.

`targetSdk` is deliberately 30. Apps targeting 31+ can't read the hidden settings keys this app checks, such as `ble_scan_always_enabled` and `nearby_scanning_enabled`. The app is sideloaded, so no store target floor applies.

## Status

Experimental. It compiles and lints clean, but it hasn't been run on a One UI 9 device yet. The whole point of the verify-after-apply design is that a path Samsung silently ignores shows up as `NOT verified ✗` instead of failing quietly. Send a Diagnostics report if something misbehaves.

#!/bin/sh
# One-time setup over USB (phone: Developer options → USB debugging on).
# Gives Warden the extra rights Android only hands out through adb. Safe to run again.
set -e
P=io.github.genmnz.warden
adb shell pm grant $P android.permission.WRITE_SECURE_SETTINGS   # settings lock for Global/Secure keys
adb shell appops set $P android:mock_location allow              # = "Select mock location app → Warden"
adb shell appops set $P WRITE_SETTINGS allow                      # settings lock for System keys
adb shell dumpsys deviceidle whitelist +$P                       # never put to sleep by Doze
echo "Done. Open Warden: the Settings lock section should show two green ticks."

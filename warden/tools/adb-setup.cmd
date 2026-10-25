@echo off
rem One-time setup over USB (phone: Developer options -> USB debugging on). Safe to run again.
set P=io.github.genmnz.warden
adb shell pm grant %P% android.permission.WRITE_SECURE_SETTINGS
adb shell appops set %P% android:mock_location allow
adb shell appops set %P% WRITE_SETTINGS allow
adb shell dumpsys deviceidle whitelist +%P%
echo Done. Open Warden: the Settings lock section should show two green ticks.
pause

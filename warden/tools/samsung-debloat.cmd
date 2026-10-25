@echo off
rem Disables the packages listed in samsung-packages.txt. Undo: samsung-debloat.cmd --undo
cd /d "%~dp0"
set CMD=pm disable-user --user 0
if "%1"=="--undo" set CMD=pm enable --user 0
for /f "eol=# tokens=1" %%p in (samsung-packages.txt) do adb shell %CMD% %%p
pause

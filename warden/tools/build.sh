#!/bin/sh
# Builds the release APK into dist/. Needs a JDK 17+ and the Android SDK (ANDROID_HOME or local.properties).
set -e
cd "$(dirname "$0")/.."
tools/test.sh
[ -f warden.jks ] || tools/make-key.sh
./gradlew assembleRelease --no-daemon -q
mkdir -p dist
cp app/build/outputs/apk/release/app-release.apk dist/Warden.apk
ls -l dist/Warden.apk

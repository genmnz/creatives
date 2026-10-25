#!/bin/sh
# Creates your personal signing key (once). Keep the file and reuse it: Android only installs an
# update over the old version if both are signed with the same key. Never commit it (gitignored).
cd "$(dirname "$0")/.."
keytool -genkeypair -keystore warden.jks -alias warden -keyalg RSA -keysize 2048 -validity 36500 \
    -storepass "${WARDEN_KS_PASS:-warden}" -keypass "${WARDEN_KS_PASS:-warden}" -dname "CN=Warden"

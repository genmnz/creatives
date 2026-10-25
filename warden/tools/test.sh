#!/bin/sh
# Runs the desktop tests for the packet/DNS/blocklist code (needs only a JDK).
set -e
cd "$(dirname "$0")/.."
out=$(mktemp -d)
src=app/src/main/java/io/github/genmnz/warden
javac -d "$out" $src/Packets.java $src/Blocklist.java test/PacketsTest.java
java -cp "$out" io.github.genmnz.warden.PacketsTest app/src/main/assets/lists
rm -rf "$out"

#!/bin/sh
# Runs the desktop tests for the packet/DNS/blocklist and earbud code (needs only a JDK).
set -e
cd "$(dirname "$0")/.."
out=$(mktemp -d)
src=app/src/main/java/io/github/genmnz/warden
javac -d "$out" $src/Packets.java $src/Blocklist.java $src/Earbuds.java $src/JlAuth.java test/*.java
java -cp "$out" io.github.genmnz.warden.PacketsTest app/src/main/assets/lists
java -cp "$out" io.github.genmnz.warden.EarbudsTest
rm -rf "$out"

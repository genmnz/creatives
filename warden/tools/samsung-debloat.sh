#!/bin/sh
# Disables the packages listed in samsung-packages.txt. Undo: ./samsung-debloat.sh --undo
cd "$(dirname "$0")"
cmd="pm disable-user --user 0"
[ "$1" = "--undo" ] && cmd="pm enable --user 0"
grep -v '^#' samsung-packages.txt | while read -r p; do
    [ -n "$p" ] && echo "$p: $(adb shell $cmd "$p" 2>&1)"
done

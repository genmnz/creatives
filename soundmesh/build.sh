#!/bin/sh
# Cross-compile from Linux (needs mingw-w64: apt install mingw-w64).
# On Windows with MSYS2/mingw, the same commands work.
#   dist/soundmesh.exe      - the window app (double-click it)
#   dist/soundmesh-cli.exe  - same engine as a console program, for scripts
set -e
cd "$(dirname "$0")"
mkdir -p dist build
CXX=${CXX:-x86_64-w64-mingw32-g++}
CC=${CC:-x86_64-w64-mingw32-gcc}
WINDRES=${WINDRES:-x86_64-w64-mingw32-windres}
FLAGS="-std=c++17 -O2 -s -static -Wall -Wno-unknown-pragmas"
LIBS="-lole32 -lws2_32 -lavrt -lwinmm -lshell32 -liphlpapi -lsetupapi -lcfgmgr32"

$WINDRES res/soundmesh.rc -O coff -o build/res.o
$CC -std=c99 -O2 -c src/third_party/qrcodegen.c -o build/qrcodegen.o   # QR code for the phone page (MIT, Project Nayuki)
$CXX $FLAGS -mwindows src/soundmesh.cpp build/res.o build/qrcodegen.o -o dist/soundmesh.exe $LIBS -lcomctl32 -lgdi32
$CXX $FLAGS -DSM_CONSOLE src/soundmesh.cpp build/res.o -o dist/soundmesh-cli.exe $LIBS
ls -l dist/*.exe

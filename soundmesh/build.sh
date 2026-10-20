#!/bin/sh
# Cross-compile soundmesh.exe from Linux (needs mingw-w64: apt install mingw-w64).
# On Windows with MSYS2/mingw, the same g++ line works.
set -e
cd "$(dirname "$0")"
mkdir -p dist
CXX=${CXX:-x86_64-w64-mingw32-g++}
$CXX -std=c++17 -O2 -s -static -Wall -Wno-unknown-pragmas \
    src/soundmesh.cpp -o dist/soundmesh.exe \
    -lole32 -lws2_32 -lavrt -lwinmm -lshell32
ls -l dist/soundmesh.exe

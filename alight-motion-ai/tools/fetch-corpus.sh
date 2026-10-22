#!/usr/bin/env bash
# Collect real Alight Motion project exports from public repositories into a
# test corpus (not committed: the files belong to their authors).
#   tools/fetch-corpus.sh [dir]        default: ~/am-corpus
#   AM_CORPUS=~/am-corpus/xml npm test
# A file counts as a genuine app export when its <scene> carries amver=
# (and it is not a third-party editor's rewrite).
# The APK's bundled presets (ground truth) come from the decompile repo.
set -euo pipefail
DIR="${1:-$HOME/am-corpus}"
mkdir -p "$DIR/repos" "$DIR/xml"
REPOS=(
  kuchingneko28/alight-motion-docs
  andikachan/alight-web-editor
  Vamzz-spectre/vamx-alight-player
  Rahmadfirdiansyah/Alight-motion
  xykal/presetly
  ZvanKumpulanPreset/Zvan_Preset
  tiyanzxbellas/alight-motion-preset-finder
  CompileChaosDev/Lixxx
  Badri-collab/RC-CREATIONS-BADRI-
)
for r in "${REPOS[@]}"; do
  d="$DIR/repos/${r/\//_}"
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$r" "$d" || echo "skip $r"
done
n=0
while IFS= read -r -d '' f; do
  grep -q 'amver=' "$f" || continue
  # alight-web-editor's packages/*/project.xml are that editor's rewrites of the app's <uuid>.xml
  [[ "$f" == */packages/*/project.xml ]] && continue
  h=$(sha1sum "$f" | cut -c1-8)
  ls "$DIR/xml/${h}_"* >/dev/null 2>&1 && continue
  cp "$f" "$DIR/xml/${h}_$(basename "$f" | tr ' ' '_')"
  n=$((n + 1))
done < <(find "$DIR/repos" -name '*.xml' -print0)
echo "$n new exports in $DIR/xml"

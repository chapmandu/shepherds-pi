#!/bin/sh
# Records the README's demo from the fictional session in demo-board.mjs: docs/demo.gif, docs/demo.mp4, preview.png.
# Needs the Herdr app open with the panel showing, and ffmpeg (with librsvg and libopenh264).
# Usage: docs/record-demo.sh <terminal> [x y width height]
#   <terminal>  the terminal the panel follows, e.g. t27 (focus it first)
#   x y w h     where the panel is in a `herdr-app shot` of the window (default: 1414 48 500 1010)
# For a few seconds it switches Herdr to its default theme and shows the demo pie as You;
# everything it changes is put back when it ends, even if it fails.
set -e
T=${1:?usage: docs/record-demo.sh <terminal> [x y width height]}
X=${2:-1414} Y=${3:-48} W=${4:-500} H=${5:-1010}
R=$(cd "$(dirname "$0")/.." && pwd)
APP=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
MOD=$APP/mods/shepherds-pi MAP=$HOME/.cache/shepherds-pi/$T.json
D=$(mktemp -d)
mkdir -p "$D/f" "$(dirname "$MAP")"
ffmpeg -loglevel error -y -width 256 -height 256 -i "$R/docs/demo-avatar.svg" "$D/pie.png"

# Keep what is changed, and put it back however this ends.
cp "$APP/settings.json" "$D/settings.json"
[ -f "$MAP" ] && cp "$MAP" "$D/map.json"
restore() {
  cp "$D/settings.json" "$APP/settings.json"
  if [ -f "$D/map.json" ]; then cp "$D/map.json" "$MAP"; else rm -f "$MAP"; fi
  rm -f "$MOD/avatar.png"; touch "$MOD/main.js"
}
trap restore EXIT

# Herdr's default theme, and the pie as You.
node -e 'const fs=require("fs"),p=process.argv[1],s=JSON.parse(fs.readFileSync(p,"utf8"));delete s.theme;fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")' "$APP/settings.json"
cp "$D/pie.png" "$MOD/avatar.png"; sleep 4

# Play the session out while taking screenshots as fast as Herdr gives them, each with its time.
ms() { date +%s%3N; }
S=$(ms); node "$R/docs/demo-board.mjs" "$MAP" 1 "$S"; sleep 2.5
END=$(( $(ms) + 9000 ))
( k=0; while [ "$(ms)" -lt "$END" ]; do t=$(ms); herdr-app shot "$D/f/$(printf %04d $k).png" >/dev/null && echo "$k $t" >> "$D/times"; k=$((k+1)); done ) &
for step in 2 3 4 5; do sleep 1.7; node "$R/docs/demo-board.mjs" "$MAP" $step "$S"; done
wait
restore; trap - EXIT

# Each frame lasts until the next one was taken, so the video keeps real time.
awk 'NR>1{printf "file f/%04d.png\nduration %.3f\n", pk, ($2-pt)/1000} {pk=$1; pt=$2} END{printf "file f/%04d.png\nduration 0.04\nfile f/%04d.png\n", pk, pk}' "$D/times" > "$D/list.txt"
CROP="crop=$W:$H:$X:$Y"
cd "$D"
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -vf "$CROP,fps=30,format=yuv420p" -c:v libopenh264 -b:v 900k -movflags +faststart -an "$R/docs/demo.mp4"
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -vf "$CROP,fps=20,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$R/docs/demo.gif"
# The still: packets in flight, a moment after the agent moved on.
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -vf "$CROP,fps=30,select=eq(n\,57)" -frames:v 1 -update 1 "$R/preview.png"
rm -rf "$D"
ls -lh "$R/docs/demo.gif" "$R/docs/demo.mp4" "$R/preview.png"

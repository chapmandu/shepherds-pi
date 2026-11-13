#!/bin/sh
# Puts the Herdr mod and the pi extension in place.
# The mod is copied, not linked: Herdr does not reload a linked mod folder. Run again after editing it.
set -e
here=$(cd "$(dirname "$0")" && pwd)
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
exts="$HOME/.pi/agent/extensions"
mkdir -p "$mods" "$exts"
# Copy over the top, never delete first: Herdr stops watching a folder that was removed.
[ -L "$mods/shepherds-pi" ] && rm "$mods/shepherds-pi"
mkdir -p "$mods/shepherds-pi"
cp -R "$here/mods/shepherds-pi/." "$mods/shepherds-pi/"
ln -sfn "$here/extension" "$exts/shepherds-pi"
echo "Installed. Restart pi, then type /shepherds-pi to open the map beside the chat."

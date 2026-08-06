#!/bin/bash
# Symlink the plugin into Stream Deck's plugin folder and restart the app.
set -euo pipefail

PLUGIN_ID="com.brialvarez.claude-deck.sdPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/$PLUGIN_ID"
DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"

if [ ! -d "$SRC" ]; then
	echo "error: $SRC not found" >&2
	exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
echo "linked $DEST"

if pgrep -x "Stream Deck" >/dev/null; then
	killall "Stream Deck" || true
	sleep 2
fi
open -a "Elgato Stream Deck"
echo "Stream Deck restarted — drag Claude Deck actions onto your keys."

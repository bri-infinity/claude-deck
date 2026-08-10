#!/bin/bash
# Symlink the plugin into Stream Deck's plugin folder and restart the app.
#   ./install.sh          install + report missing prerequisites
#   ./install.sh --check  only report prerequisites, change nothing
set -euo pipefail

PLUGIN_ID="com.claudedeck.plugin.sdPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/$PLUGIN_ID"
DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"

check_prerequisites() {
	local ok=0
	echo ""
	echo "Prerequisite check (features degrade gracefully when missing):"

	# Notification hook -> "needs approval" state + approve/deny targeting
	if grep -qs "claude-deck/events.jsonl" "$HOME/.claude/settings.json"; then
		echo "  [ok] Claude Code Notification hook installed"
	else
		ok=1
		echo "  [--] Claude Code Notification hook NOT installed"
		echo "       -> sessions won't show 'needs approval'; see README 'needs approval detection'"
	fi

	# cmux socket access -> workspace/surface jump + focus-free approve/deny
	if [ -x "/Applications/cmux.app/Contents/Resources/bin/cmux" ]; then
		local mode_ok=1 pw_ok=1
		grep -qs '"socketControlMode"[[:space:]]*:[[:space:]]*"password"' "$HOME/.config/cmux/cmux.json" || mode_ok=0
		[ -s "$HOME/.local/state/cmux/socket-control-password" ] || pw_ok=0
		if [ "$mode_ok" = 1 ] && [ "$pw_ok" = 1 ]; then
			echo "  [ok] cmux socket access configured"
		else
			ok=1
			echo "  [--] cmux detected but socket access NOT configured"
			[ "$mode_ok" = 0 ] && echo "       -> set automation.socketControlMode to \"password\" in ~/.config/cmux/cmux.json"
			[ "$pw_ok" = 0 ] && echo "       -> write a password to ~/.local/state/cmux/socket-control-password"
			echo "       -> then restart cmux; see README 'cmux socket access'"
		fi
	else
		echo "  [i ] cmux not installed — Terminal.app / iTerm2 will be used instead"
	fi
	echo ""
	return $ok
}

if [ "${1:-}" = "--check" ]; then
	check_prerequisites
	exit $?
fi

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

check_prerequisites || true

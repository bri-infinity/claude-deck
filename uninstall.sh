#!/bin/bash
# Uninstall Claude Deck: unlink the plugin and undo what install.sh set up.
#   ./uninstall.sh              remove plugin, hook, and plugin state
#   ./uninstall.sh --keep-data  keep ~/.claude/claude-deck (events/dismissals)
#
# cmux's socket-access config is only reverted after an explicit prompt —
# other tools may rely on it, and reverting requires a cmux restart.
set -euo pipefail

PLUGIN_ID="com.claudedeck.plugin.sdPlugin"
DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"
SETTINGS="$HOME/.claude/settings.json"
DATA_DIR="$HOME/.claude/claude-deck"
CMUX_JSON="$HOME/.config/cmux/cmux.json"
CMUX_PW_FILE="$HOME/.local/state/cmux/socket-control-password"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP_DATA=0
[ "${1:-}" = "--keep-data" ] && KEEP_DATA=1

find_node() {
	command -v node 2>/dev/null && return 0
	ls -d "$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"/*/node 2>/dev/null | head -1 && return 0
	[ -x "$(dirname "$0")/.tools/node/bin/node" ] && echo "$(dirname "$0")/.tools/node/bin/node" && return 0
	return 1
}

# --- 1. Unlink the plugin ---------------------------------------------------
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
	rm -rf "$DEST"
	echo "[1/3] plugin unlinked"
	if pgrep -x "Stream Deck" >/dev/null; then
		killall "Stream Deck" || true
		sleep 2
		open -a "Elgato Stream Deck"
		echo "      Stream Deck restarted"
	fi
else
	echo "[1/3] plugin was not linked"
fi

# --- 2. Remove the Notification hook ---------------------------------------
if grep -qs "claude-deck/events.jsonl" "$SETTINGS"; then
	NODE="$(find_node)" || { echo "[2/3] SKIPPED: no Node found — remove the claude-deck Notification hook from settings.json manually"; NODE=""; }
	if [ -n "$NODE" ]; then
		cp "$SETTINGS" "$SETTINGS.claude-deck-$STAMP.bak"
		SETTINGS="$SETTINGS" "$NODE" -e '
			const fs = require("fs");
			const file = process.env.SETTINGS;
			const s = JSON.parse(fs.readFileSync(file, "utf8"));
			const marker = "claude-deck/events.jsonl";
			for (const group of s.hooks?.Notification ?? []) {
				group.hooks = (group.hooks ?? []).filter(
					(h) => !String(h.command ?? "").includes(marker),
				);
			}
			if (s.hooks?.Notification) {
				s.hooks.Notification = s.hooks.Notification.filter((g) => (g.hooks ?? []).length);
				if (!s.hooks.Notification.length) delete s.hooks.Notification;
				if (!Object.keys(s.hooks).length) delete s.hooks;
			}
			fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
		'
		echo "[2/3] Notification hook removed (backup: settings.json.claude-deck-$STAMP.bak)"
	fi
else
	echo "[2/3] Notification hook was not installed"
fi

# --- 3. Plugin state --------------------------------------------------------
if [ "$KEEP_DATA" = 1 ]; then
	echo "[3/3] keeping $DATA_DIR"
elif [ -d "$DATA_DIR" ]; then
	rm -rf "$DATA_DIR"
	echo "[3/3] removed $DATA_DIR"
else
	echo "[3/3] no plugin state to remove"
fi

# --- optional: revert cmux socket access ------------------------------------
if grep -qs '"socketControlMode"[[:space:]]*:[[:space:]]*"password"' "$CMUX_JSON"; then
	echo ""
	echo "cmux socket access is still set to password mode (claude-deck set this"
	echo "up, but other tools may use it too)."
	if [ -t 0 ]; then
		read -r -p "Revert cmux to its default (cmuxOnly) and delete the password file? [y/N] " ans
		if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
			NODE="${NODE:-$(find_node || true)}"
			if [ -n "${NODE:-}" ]; then
				cp "$CMUX_JSON" "$CMUX_JSON.claude-deck-$STAMP.bak"
				CMUX_JSON="$CMUX_JSON" "$NODE" -e '
					const fs = require("fs");
					const file = process.env.CMUX_JSON;
					const text = fs.readFileSync(file, "utf8")
						.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
						.replace(/,(\s*[}\]])/g, "$1");
					const obj = JSON.parse(text);
					if (obj.automation) {
						delete obj.automation.socketControlMode;
						if (!Object.keys(obj.automation).length) delete obj.automation;
					}
					fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
				'
				rm -f "$CMUX_PW_FILE"
				echo "reverted — restart cmux when convenient for it to take effect"
			else
				echo "SKIPPED: no Node found — edit cmux.json manually"
			fi
		else
			echo "left as-is"
		fi
	else
		echo "Run interactively to revert it, or edit ~/.config/cmux/cmux.json manually."
	fi
fi

echo ""
echo "Claude Deck uninstalled. The repo itself was not deleted."

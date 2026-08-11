#!/bin/bash
# Install Claude Deck: link the plugin, configure prerequisites, restart apps.
#   ./install.sh          full install (idempotent — safe to re-run)
#   ./install.sh --check  report what is / isn't configured, change nothing
set -euo pipefail

PLUGIN_ID="com.claudedeck.plugin.sdPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/$PLUGIN_ID"
DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$PLUGIN_ID"
SETTINGS="$HOME/.claude/settings.json"
CMUX_BIN="/Applications/cmux.app/Contents/Resources/bin/cmux"
CMUX_JSON="$HOME/.config/cmux/cmux.json"
CMUX_PW_FILE="$HOME/.local/state/cmux/socket-control-password"
HOOK_CMD='mkdir -p ~/.claude/claude-deck; printf '\''{"t":%s,"event":%s}\n'\'' "$(date +%s)" "$(cat)" >> ~/.claude/claude-deck/events.jsonl'
STAMP="$(date +%Y%m%d-%H%M%S)"

# A Node interpreter for JSON merging: system node, else Stream Deck's bundled
# runtime, else the repo-local dev copy. (The plugin itself never needs this.)
find_node() {
	command -v node 2>/dev/null && return 0
	ls -d "$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"/*/node 2>/dev/null | head -1 && return 0
	[ -x "$(dirname "$0")/.tools/node/bin/node" ] && echo "$(dirname "$0")/.tools/node/bin/node" && return 0
	return 1
}

hook_installed() { grep -qs "claude-deck/events.jsonl" "$SETTINGS"; }
cmux_mode_ok() { grep -qs '"socketControlMode"[[:space:]]*:[[:space:]]*"password"' "$CMUX_JSON"; }
cmux_pw_ok() { [ -s "$CMUX_PW_FILE" ]; }

report() {
	echo ""
	echo "Status:"
	if hook_installed; then echo "  [ok] Claude Code Notification hook"; else echo "  [--] Notification hook missing -> no 'needs approval' state or approve/deny targeting"; fi
	if [ -x "$CMUX_BIN" ]; then
		if cmux_mode_ok && cmux_pw_ok; then echo "  [ok] cmux socket access"; else echo "  [--] cmux socket access not configured -> no workspace jump / key injection"; fi
	else
		echo "  [i ] cmux not installed — Terminal.app / iTerm2 fallback will be used"
	fi
	echo ""
}

if [ "${1:-}" = "--check" ]; then
	report
	exit 0
fi

[ -d "$SRC" ] || { echo "error: $SRC not found" >&2; exit 1; }

# --- 1. Link the plugin -----------------------------------------------------
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
echo "[1/3] plugin linked"

# --- 2. Claude Code Notification hook (idempotent JSON merge, with backup) --
if hook_installed; then
	echo "[2/3] Notification hook already installed"
else
	NODE="$(find_node)" || { echo "[2/3] SKIPPED: no Node found to edit settings.json — add the hook manually (see README)"; NODE=""; }
	if [ -n "$NODE" ]; then
		mkdir -p "$(dirname "$SETTINGS")"
		[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.claude-deck-$STAMP.bak"
		HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" "$NODE" -e '
			const fs = require("fs");
			const file = process.env.SETTINGS;
			let s = {};
			try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
			s.hooks = s.hooks ?? {};
			s.hooks.Notification = s.hooks.Notification ?? [];
			s.hooks.Notification.push({
				hooks: [{ type: "command", command: process.env.HOOK_CMD, timeout: 10 }],
			});
			fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
		'
		echo "[2/3] Notification hook installed (backup: settings.json.claude-deck-$STAMP.bak)"
		echo "      note: claude sessions already running pick it up after a restart (or open /hooks once)"
	fi
fi

# --- 3. cmux socket access (only if cmux is installed) ----------------------
CMUX_NEEDS_RESTART=0
if [ -x "$CMUX_BIN" ]; then
	if ! cmux_pw_ok; then
		mkdir -p "$(dirname "$CMUX_PW_FILE")"
		(umask 077 && openssl rand -hex 24 > "$CMUX_PW_FILE")
		echo "[3/3] cmux socket password generated"
	fi
	if ! cmux_mode_ok; then
		NODE="${NODE:-$(find_node || true)}"
		if [ -n "${NODE:-}" ]; then
			mkdir -p "$(dirname "$CMUX_JSON")"
			[ -f "$CMUX_JSON" ] && cp "$CMUX_JSON" "$CMUX_JSON.claude-deck-$STAMP.bak"
			CMUX_JSON="$CMUX_JSON" "$NODE" -e '
				const fs = require("fs");
				const file = process.env.CMUX_JSON;
				let obj = {};
				try {
					// cmux.json is JSONC: strip // comments and trailing commas
					const text = fs.readFileSync(file, "utf8")
						.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
						.replace(/,(\s*[}\]])/g, "$1");
					obj = JSON.parse(text);
				} catch {}
				obj.automation = obj.automation ?? {};
				obj.automation.socketControlMode = "password";
				fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
			'
			CMUX_NEEDS_RESTART=1
			echo "[3/3] cmux socket mode set to password (backup: cmux.json.claude-deck-$STAMP.bak)"
		else
			echo "[3/3] SKIPPED: no Node found to edit cmux.json — set socketControlMode manually (see README)"
		fi
	else
		echo "[3/3] cmux socket access already configured"
	fi
else
	echo "[3/3] cmux not installed — skipping (Terminal.app / iTerm2 will be used)"
fi

# --- restart Stream Deck ----------------------------------------------------
if pgrep -x "Stream Deck" >/dev/null; then
	killall "Stream Deck" || true
	sleep 2
fi
open -a "Elgato Stream Deck"
echo "Stream Deck restarted — drag Claude Deck actions onto your keys."

# cmux reads the socket mode at startup; restarting it closes its terminals,
# so never do that silently.
if [ "$CMUX_NEEDS_RESTART" = 1 ]; then
	echo ""
	echo "cmux must be restarted once to apply password mode (its terminal"
	echo "sessions will close; cmux restores them on relaunch)."
	if [ -t 0 ] && pgrep -qx cmux; then
		read -r -p "Restart cmux now? [y/N] " ans
		if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
			killall cmux || true
			sleep 2
			open -a cmux
			echo "cmux restarted."
		else
			echo "Skipped — quit and reopen cmux when convenient."
		fi
	else
		echo "Quit and reopen cmux when convenient."
	fi
fi

report

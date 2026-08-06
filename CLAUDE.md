# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS Stream Deck plugin for Claude Code: per-session keys (jump to a session's terminal, approve/deny permission prompts), local usage/cost tracking, and plan-limit bars. See README.md for the user-facing feature and setup docs.

## Hard constraint: zero dependencies

There is no `node_modules`, no bundler, and no build step — and that is deliberate (the plugin must run wherever the Stream Deck app drops it, with the app's own Node runtime). Do not add npm dependencies; the Stream Deck WebSocket protocol, PNG encoding, and HTTP are all hand-implemented in-tree. Plain ES modules under `bin/` are loaded directly by Node.

## Commands

```sh
# Data-pipeline smoke test WITHOUT a Stream Deck: prints sessions, claude
# processes, cmux surface map, and plan limits as JSON. Run after any change.
node com.claudedeck.plugin.sdPlugin/bin/plugin.js --test

# Syntax-check all modules (there is no linter config)
for f in com.claudedeck.plugin.sdPlugin/bin/plugin.js com.claudedeck.plugin.sdPlugin/bin/lib/*.js; do node --check "$f"; done

# Regenerate all PNG icons (pure-Node SDF renderer)
node gen-icons.mjs

# Regenerate README example images (docs/img/*.svg) from the real face
# renderer — run after changing faces.js so the docs match
node gen-docs.mjs

# Symlink the plugin into Stream Deck and restart the app
./install.sh
```

**Reloading after edits:** the plugin process only restarts with the Stream Deck app — `killall "Stream Deck"; open -a "Elgato Stream Deck"`. Runtime behavior is diagnosed from `com.claudedeck.plugin.sdPlugin/logs/claude-deck.log` (every Stream Deck event and every failure path is logged; rotates at 512KB).

If the machine has no system Node, a standalone one may live at `.tools/node/bin/node` (gitignored) — dev scripts only; the plugin itself uses Stream Deck's bundled runtime.

## Architecture

Entry point `bin/plugin.js` owns all mutable UI state (visible key contexts, session paging, long-press timers, per-key in-flight guards) and wires the modules in `bin/lib/`:

- **collector.js** — the data layer. Incrementally parses Claude Code transcripts (`~/.claude/projects/*/*.jsonl`, offset-tracked via `jsonl.js`) into session metadata + usage entries, and merges "waiting for permission/input" state from `~/.claude/claude-deck/events.jsonl` (written by a user-installed Notification hook — see README). Key lifecycle rule: a notification event marks a session waiting; **any transcript growth clears it**. Also owns dismissed-session persistence (`~/.claude/claude-deck/hidden.json`).
- **terminals.js / cmux.js** — the "where is this session?" layer. `claudeProcesses()` matches sessions to processes by cwd (`ps` + one batched `lsof`); cmux surfaces are found by TTY from `cmux tree`, with a cwd fallback via `cmux debug-terminals` for restored surfaces whose TTY cmux lost. `locateSession()` in plugin.js glues these: it prefers a cmux surface over a bare TTY over "running but unreachable".
- **faces.js** — pure functions from data to 144×144 SVG data URIs. No module state reads; callers pass a view model. Keep it that way.
- **limits.js** — calls the same OAuth usage endpoint `/usage` uses, authenticated with the user's existing Claude Code token (Keychain, read-only). Self-throttles: 2-min base interval, 10-min backoff on 429, curl fallback when the plugin's own sockets are firewalled.
- **ws.js** — minimal RFC 6455 client for Stream Deck's localhost socket. No fragmentation support (documented; Stream Deck frames are small). On close the process exits and Stream Deck relaunches it.

### Invariants to preserve

- **Never resume a session that has a running process** — that duplicates it. `handleSessionPress` only falls through to `claude --resume` when no process matches.
- **Keystrokes only to an exact match**: approve/deny either injects via `cmux send-key` to the matched surface, or focuses the exact Terminal/iTerm tab by TTY first. Never synthesize a keystroke without a confirmed focus target.
- **cmux handles must use UUIDs**, not short refs (`workspace:N` renumbers as workspaces close). `cmuxState()` captures UUIDs for window/workspace/surface; keep passing those.
- **Per-key presses are serialized** (`guarded()`); Stream Deck sends keyDown/keyUp per press and Session keys decide quick-press vs long-press (dismiss) on keyUp.

### cmux socket auth (why `runCmux` passes a password)

cmux's control socket rejects processes outside its own tree unless `socketControlMode: "password"` is set; the password lives in `~/.local/state/cmux/socket-control-password` and is passed via the `CMUX_SOCKET_PASSWORD` env var. Don't write the password into `cmux.json` — the app strips it on restart.

## Cost figures are estimates

Pricing lives in `config.js` as per-MTok rates by model-name substring (cache writes 1.25× input, cache reads 0.1×). Update rates there when Anthropic pricing changes; unknown models fall back to Opus-tier.

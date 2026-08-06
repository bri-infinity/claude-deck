// Central configuration: paths, timing, action IDs, and pricing.
import path from "node:path";
import os from "node:os";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export const EVENTS_FILE = path.join(os.homedir(), ".claude", "claude-deck", "events.jsonl");
export const HIDDEN_FILE = path.join(os.homedir(), ".claude", "claude-deck", "hidden.json");
export const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
export const CMUX_APP = "/Applications/cmux.app";
export const CMUX_PASSWORD_FILE = path.join(
	os.homedir(),
	".local",
	"state",
	"cmux",
	"socket-control-password",
);

export const REFRESH_MS = 5_000; // main scan/render tick
export const LIMITS_REFRESH_MS = 60_000; // limits tick (self-throttled further)
export const ACTIVE_WINDOW_MS = 5 * 60_000; // "active" = transcript changed within 5 min
export const RUNNING_WINDOW_MS = 60_000; // "running" = written to in the last minute
export const RETAIN_MS = 8 * 24 * 3_600_000; // usage entries kept for the 7-day view
export const SESSION_LIST_WINDOW_MS = 24 * 3_600_000; // idle sessions leave the deck after this
export const LONG_PRESS_MS = 600; // hold a Session key this long to dismiss it

export const ACTION_SESSION = "com.claudedeck.plugin.session";
export const ACTION_APPROVE = "com.claudedeck.plugin.approve";
export const ACTION_DENY = "com.claudedeck.plugin.deny";
export const ACTION_SESSIONS = "com.claudedeck.plugin.sessions";
export const ACTION_USAGE = "com.claudedeck.plugin.usage";
export const ACTION_LIMITS = "com.claudedeck.plugin.limits";

// Pricing per million tokens: [model substring, input, output].
// Cache writes bill at 1.25x input (5-minute TTL), cache reads at 0.1x input.
const PRICING = [
	["fable", 10, 50],
	["mythos", 10, 50],
	["opus", 5, 25],
	["sonnet", 3, 15],
	["haiku", 1, 5],
];

export function ratesFor(model) {
	const m = String(model ?? "").toLowerCase();
	for (const [key, inp, out] of PRICING) {
		if (m.includes(key)) return { inp, out };
	}
	return { inp: 5, out: 25 }; // unknown models: assume Opus-tier
}

// Claude Deck — Stream Deck plugin for Claude Code sessions and usage.
//
// Zero-dependency: talks the Stream Deck WebSocket protocol directly over
// node:net (the Stream Deck app runs a plain ws:// server on localhost).
//
// Actions:
//   .session  — one key per recent session: project, state, activity.
//               Press: jump to its terminal (cmux workspace or Terminal/iTerm
//               tab), or resume it if idle. Long-press: dismiss from the deck.
//   .approve  — approve the pending permission request (cmux surface key
//               injection, or focus tab + Return)
//   .deny     — same, with Escape
//   .sessions — mini session list; press pages the .session keys
//   .usage    — local cost + tokens (press cycles Today / Last 5h / 7 days)
//   .limits   — real plan limits from the /usage endpoint (5h / weekly bars)
//
// Module map (bin/lib/):
//   collector.js — transcripts + notification events -> sessions/usage state
//   terminals.js — claude process discovery, Terminal/iTerm AppleScript
//   cmux.js      — cmux surface mapping, workspace focus, key injection
//   limits.js    — OAuth usage endpoint client (plan-limit percentages)
//   faces.js     — pure SVG key-face rendering
//   ws.js        — minimal RFC 6455 client for the Stream Deck socket
import fs from "node:fs";
import path from "node:path";
import { log } from "./lib/log.js";
import {
	EVENTS_FILE,
	REFRESH_MS,
	LIMITS_REFRESH_MS,
	LONG_PRESS_MS,
	ACTION_SESSION,
	ACTION_APPROVE,
	ACTION_DENY,
	ACTION_SESSIONS,
	ACTION_USAGE,
	ACTION_LIMITS,
} from "./lib/config.js";
import { monitor, eventsWatcher, dismissSessionId } from "./lib/collector.js";
import { sleep } from "./lib/exec.js";
import { claudeProcesses, focusTty, openResume, pressKey } from "./lib/terminals.js";
import {
	cmuxAvailable,
	cmuxState,
	cmuxLocByCwd,
	cmuxFocus,
	cmuxSendKey,
	cmuxResume,
} from "./lib/cmux.js";
import { limits } from "./lib/limits.js";
import {
	statFace,
	sessionFace,
	approveFace,
	denyFace,
	sessionsListFace,
	limitsFace,
	fmtCost,
	fmtTokens,
	ago,
} from "./lib/faces.js";
import { MiniWebSocket } from "./lib/ws.js";

const WINDOWS = [
	{ label: "TODAY", since: () => new Date().setHours(0, 0, 0, 0) },
	{ label: "LAST 5H", since: () => Date.now() - 5 * 3_600_000 },
	{ label: "7 DAYS", since: () => Date.now() - 7 * 24 * 3_600_000 },
];

/**
 * Where is this session running?
 *   { loc, running }  — inside a cmux surface (preferred)
 *   { tty, running }  — on a plain terminal tty
 *   { running }       — process exists but is headless/unfocusable
 *   {}                — not running
 *
 * Two phases, most exact source first, because several sessions can share
 * one workspace and even one cwd — identity beats location.
 * Which process is this session?
 *   1. the `--resume <id>` in a resumed process's argv
 *   2. process cwd (only processes not claiming a different session)
 * Which cmux surface hosts it?
 *   1. CMUX_SURFACE_ID from the process environment (survives all cmux versions)
 *   2. cmux's per-surface resume record (older cmux)
 *   3. the process tty in cmux's surface tree (older cmux)
 *   4. surface cwd via `cmux debug-terminals`
 */
async function locateSession(session, state) {
	if (!session?.id) return {};
	const procs = await claudeProcesses();

	// processes belonging to this session: exact argv identity, else cwd
	let matches = procs.filter((p) => p.sessionId === session.id);
	if (!matches.length && session.cwd) {
		// only trust cwd for processes that don't claim a *different* session
		matches = procs.filter((p) => p.cwd === session.cwd && !p.sessionId);
	}

	// authoritative: the surface id cmux injected into the process's env
	const envMatch = matches.find((p) => p.cmuxSurfaceUuid);
	if (envMatch) {
		return {
			loc: {
				surfaceUuid: envMatch.cmuxSurfaceUuid,
				workspaceUuid: envMatch.cmuxWorkspaceUuid ?? null,
				surface: null,
				workspace: null,
				windowUuid: null,
			},
			tty: envMatch.tty,
			running: true,
		};
	}

	// exact surface for this session id (works even when process matching
	// fails, e.g. after cwd drift) — but only jump there if something runs
	const exactSurface = state.sessionMap.get(session.id);
	const looksAlive = matches.length > 0 || session.state !== "idle";
	if (exactSurface && looksAlive) {
		return { loc: exactSurface, tty: matches[0]?.tty ?? null, running: true };
	}

	if (!matches.length) {
		log(
			`locateSession: no process for ${session.name} (${session.id.slice(0, 8)}); procs=${JSON.stringify(
				procs.map((p) => ({ pid: p.pid, tty: p.tty, cwd: p.cwd, sid: p.sessionId?.slice(0, 8) })),
			)}`,
		);
		return {};
	}
	const inMap = matches.find((p) => state.ttyMap.has(p.tty));
	if (inMap) return { loc: state.ttyMap.get(inMap.tty), tty: inMap.tty, running: true };
	// cmux may have lost the surface's tty (restored workspace) — match by cwd
	const byCwd = session.cwd ? await cmuxLocByCwd(session.cwd, state) : null;
	if (byCwd) return { loc: byCwd, tty: matches[0].tty ?? null, running: true };
	return { tty: matches[0].tty ?? null, running: true };
}

// ---------------------------------------------------------------------------
// Standalone test mode: `node bin/plugin.js --test`
// ---------------------------------------------------------------------------

if (process.argv.includes("--test")) {
	eventsWatcher.poll();
	monitor.scan();
	const out = {
		activeSessions: monitor.activeSessionCount(),
		todaySessions: monitor.todaySessionCount(),
		entries: monitor.entries.length,
		sessions: monitor.sessionList().slice(0, 6).map((s) => ({
			name: s.name,
			state: s.state,
			ago: ago(s.mtime),
			id: s.id.slice(0, 8),
		})),
		approvalTarget: monitor.approvalTarget()?.name ?? null,
	};
	for (const w of WINDOWS) {
		const { cost, tokens } = monitor.totals(w.since());
		out[w.label] = `${fmtCost(cost)} / ${fmtTokens(tokens)}`;
	}
	console.log(JSON.stringify(out, null, 2));
	console.log("claude processes:", JSON.stringify(await claudeProcesses()));
	if (cmuxAvailable()) {
		const st = await cmuxState();
		console.log("cmux surfaces:", JSON.stringify(st.surfaces));
		console.log(
			"cmux session map:",
			JSON.stringify([...st.sessionMap.keys()].map((k) => k.slice(0, 8))),
		);
	}
	await limits.refresh();
	console.log("limits:", JSON.stringify(limits.rows));
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Stream Deck wiring
// ---------------------------------------------------------------------------

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const port = Number(arg("-port"));
const pluginUUID = arg("-pluginUUID");
const registerEvent = arg("-registerEvent");

if (!port || !pluginUUID || !registerEvent) {
	log(`bad launch args: ${process.argv.join(" ")}`);
	process.exit(1);
}

const ws = new MiniWebSocket(port);

/** action UUID -> Map<context, {row, col}> */
const contexts = new Map([
	[ACTION_SESSION, new Map()],
	[ACTION_APPROVE, new Map()],
	[ACTION_DENY, new Map()],
	[ACTION_SESSIONS, new Map()],
	[ACTION_USAGE, new Map()],
	[ACTION_LIMITS, new Map()],
]);

const usageWindow = new Map(); // context -> WINDOWS index
const pressStart = new Map(); // context -> keyDown timestamp (long-press detection)
const inFlight = new Set(); // contexts with a press handler still running
let sessionPage = 0; // which page of sessions the Session slot keys show

function setImage(context, image) {
	ws.sendJSON({ event: "setImage", context, payload: { image, target: 0 } });
}

function showOk(context) {
	ws.sendJSON({ event: "showOk", context });
}

function showAlert(context) {
	ws.sendJSON({ event: "showAlert", context });
}

/** Serialize presses per key: a re-press while busy is ignored (prevents
 * e.g. double-resuming a session into two workspaces). */
async function guarded(context, fn) {
	if (inFlight.has(context)) return;
	inFlight.add(context);
	try {
		await fn();
	} finally {
		inFlight.delete(context);
	}
}

/** Session keys sorted by deck position (top-left first). */
function sessionSlots() {
	return [...contexts.get(ACTION_SESSION).entries()]
		.sort(([, a], [, b]) => a.row - b.row || a.col - b.col)
		.map(([ctx]) => ctx);
}

function sessionPageCount() {
	const slotCount = sessionSlots().length;
	if (!slotCount) return 1;
	return Math.max(1, Math.ceil(monitor.sessionList().length / slotCount));
}

function sessionForContext(context) {
	const slots = sessionSlots();
	const idx = slots.indexOf(context);
	if (idx === -1) return null;
	return monitor.sessionList()[sessionPage * slots.length + idx] ?? null;
}

function renderAll() {
	const sessions = monitor.sessionList();
	const slots = sessionSlots();
	const pages = slots.length ? Math.max(1, Math.ceil(sessions.length / slots.length)) : 1;
	if (sessionPage >= pages) sessionPage = 0;
	const offset = sessionPage * slots.length;

	slots.forEach((ctx, i) => setImage(ctx, sessionFace(sessions[offset + i] ?? null)));

	const target = monitor.approvalTarget();
	for (const ctx of contexts.get(ACTION_APPROVE).keys()) {
		setImage(ctx, approveFace(target));
	}
	for (const ctx of contexts.get(ACTION_DENY).keys()) {
		setImage(ctx, denyFace(target));
	}

	for (const ctx of contexts.get(ACTION_SESSIONS).keys()) {
		setImage(
			ctx,
			sessionsListFace(sessions, {
				offset,
				slotCount: slots.length,
				page: sessionPage,
				pages,
				active: monitor.activeSessionCount(),
				today: monitor.todaySessionCount(),
			}),
		);
	}

	for (const ctx of contexts.get(ACTION_USAGE).keys()) {
		const win = WINDOWS[usageWindow.get(ctx) ?? 0];
		const { cost, tokens } = monitor.totals(win.since());
		const value = fmtCost(cost);
		setImage(
			ctx,
			statFace({
				label: win.label,
				value,
				valueSize: value.length > 6 ? 34 : 44,
				sub: fmtTokens(tokens),
			}),
		);
	}

	const stale = limits.rows && Date.now() - limits.fetchedAt > 5 * 60_000;
	for (const ctx of contexts.get(ACTION_LIMITS).keys()) {
		setImage(ctx, limitsFace(limits.rows, stale));
	}
}

/** Long-press on a Session key: hide the session until it has new activity. */
function dismissSession(context) {
	const session = sessionForContext(context);
	if (!session) {
		showAlert(context);
		return;
	}
	dismissSessionId(session.id, session.mtime);
	log(`dismissed session ${session.name} (${session.id.slice(0, 8)})`);
	renderAll();
	showOk(context);
}

async function handleSessionPress(context) {
	const session = sessionForContext(context);
	if (!session) {
		showAlert(context);
		return;
	}
	const state = cmuxAvailable() ? await cmuxState() : { surfaces: [], ttyMap: new Map(), sessionMap: new Map() };
	const where = await locateSession(session, state);

	if (where.loc) {
		// running inside a cmux surface: jump to its workspace
		if (await cmuxFocus(where.loc)) {
			showOk(context);
			return;
		}
	}
	if (where.tty && (await focusTty(where.tty))) {
		// plain Terminal.app / iTerm2 tab
		showOk(context);
		return;
	}
	if (where.running) {
		// Running, but nowhere we can focus (orphaned pty or headless process).
		// Never resume a running session — that would duplicate it.
		log(
			`sessionPress: ${session.name} running but unfocusable (tty=${where.tty ?? "none"}, orphaned?)`,
		);
		showAlert(context);
		return;
	}
	// not running: resume — in cmux if available
	const ok = cmuxAvailable() ? await cmuxResume(session) : await openResume(session);
	if (ok) showOk(context);
	else showAlert(context);
}

/** decision: "approve" (Return/enter) or "deny" (Escape) */
async function handleDecision(context, decision) {
	const target = monitor.approvalTarget();
	if (!target) {
		log(`decision(${decision}): no session is waiting for permission`);
		showAlert(context);
		return;
	}
	const state = cmuxAvailable() ? await cmuxState() : { surfaces: [], ttyMap: new Map(), sessionMap: new Map() };
	const where = await locateSession(target, state);

	// cmux surface: send the key directly — no focus stealing, no Accessibility
	if (where.loc) {
		if (await cmuxSendKey(where.loc, decision === "approve" ? "enter" : "escape")) {
			showOk(context);
		} else {
			log(`decision: cmux send-key failed for ${where.loc.surface}`);
			showAlert(context);
		}
		return;
	}

	// fallback: focus the Terminal/iTerm tab, then synthesize the keystroke
	if (where.tty && (await focusTty(where.tty))) {
		await sleep(300); // let the window come to front before the keystroke
		if (await pressKey(decision === "approve" ? 36 : 53)) {
			showOk(context);
		} else {
			log("decision: keystroke failed — grant Accessibility permission to Stream Deck");
			showAlert(context);
		}
		return;
	}

	log(
		`decision: cannot reach ${target.name} (running=${Boolean(where.running)}, tty=${where.tty ?? "none"})`,
	);
	showAlert(context);
}

ws.onopen = () => {
	ws.sendJSON({ event: registerEvent, uuid: pluginUUID });
	log("registered with Stream Deck");
	eventsWatcher.poll();
	monitor.scan();
	if (cmuxAvailable()) {
		cmuxState().then((st) =>
			log(`startup cmux probe: ${st.surfaces.length} surfaces (${st.ttyMap.size} with tty)`),
		);
	}
};

ws.onmessage = (raw) => {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	const { event, action, context, payload } = msg;
	log(`evt ${event}${action ? ` ${action.split(".").pop()}` : ""}`);

	switch (event) {
		case "willAppear": {
			const coords = payload?.coordinates ?? { column: 0, row: 0 };
			contexts.get(action)?.set(context, { row: coords.row, col: coords.column });
			renderAll();
			break;
		}
		case "willDisappear": {
			contexts.get(action)?.delete(context);
			usageWindow.delete(context);
			pressStart.delete(context);
			inFlight.delete(context);
			break;
		}
		case "keyDown": {
			if (action === ACTION_SESSION) {
				// decided on keyUp: quick press = open/focus, long press = dismiss
				pressStart.set(context, Date.now());
			} else if (action === ACTION_APPROVE) {
				guarded(context, () => handleDecision(context, "approve"));
			} else if (action === ACTION_DENY) {
				guarded(context, () => handleDecision(context, "deny"));
			} else if (action === ACTION_SESSIONS) {
				// page the Session slot keys through the full session list
				sessionPage = (sessionPage + 1) % sessionPageCount();
				monitor.scan();
				renderAll();
			} else if (action === ACTION_USAGE) {
				usageWindow.set(context, ((usageWindow.get(context) ?? 0) + 1) % WINDOWS.length);
				renderAll();
			} else if (action === ACTION_LIMITS) {
				limits.refresh(true).then(() => renderAll());
			}
			break;
		}
		case "keyUp": {
			if (action === ACTION_SESSION) {
				const started = pressStart.get(context);
				pressStart.delete(context);
				if (started && Date.now() - started >= LONG_PRESS_MS) {
					dismissSession(context);
				} else {
					guarded(context, () => handleSessionPress(context));
				}
			}
			break;
		}
		default:
			break;
	}
};

ws.onclose = () => {
	log("connection closed; exiting");
	process.exit(0);
};

// Fast reaction to hook events: watch the events dir, debounce, refresh.
try {
	fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
	let debounce = null;
	fs.watch(path.dirname(EVENTS_FILE), () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			eventsWatcher.poll();
			monitor.scan();
			renderAll();
		}, 150);
	});
} catch (err) {
	log(`fs.watch unavailable: ${err?.message ?? err}`);
}

setInterval(() => {
	eventsWatcher.poll();
	monitor.scan();
	renderAll();
}, REFRESH_MS);

limits.refresh().then(() => renderAll());
setInterval(() => {
	limits.refresh().then(() => renderAll());
}, LIMITS_REFRESH_MS);

log("claude-deck starting");

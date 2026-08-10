// cmux integration: locate sessions in cmux surfaces, focus workspaces, and
// inject keys — all via the cmux CLI over its local control socket.
//
// cmux's socket defaults to "cmuxOnly" access (its own descendant processes).
// In "password" mode, external processes like this plugin authenticate with
// the password stored in ~/.local/state/cmux/socket-control-password — the
// documented file the cmux app itself reads and watches. See the README.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { CMUX_BIN, CMUX_APP, CMUX_PASSWORD_FILE } from "./config.js";
import { run, EXEC_TIMEOUT_MS, EXEC_MAX_BUFFER } from "./exec.js";
import { log } from "./log.js";

export function cmuxAvailable() {
	try {
		fs.accessSync(CMUX_BIN, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

let pwCache = { t: 0, pw: null };
const PW_CACHE_MS = 60_000;

function cmuxPassword() {
	if (Date.now() - pwCache.t < PW_CACHE_MS) return pwCache.pw;
	let pw = null;
	try {
		pw = fs.readFileSync(CMUX_PASSWORD_FILE, "utf8").trim() || null;
	} catch {}
	pwCache = { t: Date.now(), pw };
	return pw;
}

function runCmux(args, { quiet = false } = {}) {
	const pw = cmuxPassword();
	return new Promise((resolve) => {
		execFile(
			CMUX_BIN,
			args,
			{
				timeout: EXEC_TIMEOUT_MS,
				maxBuffer: EXEC_MAX_BUFFER,
				env: pw ? { ...process.env, CMUX_SOCKET_PASSWORD: pw } : process.env,
			},
			(err, stdout, stderr) => {
				if (err) {
					if (!quiet) {
						log(
							`cmux ${args[0]} failed: ${err.code ?? ""} ${err.message?.split("\n")[0] ?? ""} stderr=${String(stderr ?? "").trim().slice(0, 200)}`,
						);
					}
					resolve(null);
					return;
				}
				resolve(String(stdout));
			},
		);
	});
}

/**
 * Snapshot of cmux surfaces: { surfaces: [...], ttyMap: Map(tty -> surface) }.
 * Each surface: { surface, surfaceUuid, workspace, workspaceUuid, window,
 * windowUuid, tty|null }. Short refs (workspace:N) renumber as workspaces
 * close, so UUIDs are captured for every handle. Restored surfaces sometimes
 * report no tty — those can still be matched by cwd via cmuxLocByCwd().
 *
 * Tree lines look like:
 *   window window:1 AE04...73 [current]
 *   ├── workspace workspace:3 B21D...07 "title" [selected]
 *   │       └── surface surface:12 4AA9...13 [terminal] "title" tty=ttys000
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The Claude session ID a surface hosts, recorded by cmux's own
 * session-start hook (also what cmux uses for its restore feature).
 * Returns null for surfaces without one (e.g. plain shells, browsers).
 */
async function surfaceSessionId(surface) {
	const ref = surface.surfaceUuid ?? surface.surface;
	// quiet: surfaces without a binding (or stale ones) error routinely
	const out = await runCmux(["surface", "resume", "show", "--surface", ref], { quiet: true });
	return out?.match(UUID_RE)?.[0]?.toLowerCase() ?? null;
}

export async function cmuxState() {
	const out = await runCmux(["tree", "--all", "--id-format", "both"]);
	const surfaces = [];
	const ttyMap = new Map();
	const sessionMap = new Map(); // claude session id -> surface
	if (!out) return { surfaces, ttyMap, sessionMap };
	let window = null;
	let windowUuid = null;
	let workspace = null;
	let workspaceUuid = null;
	for (const line of out.split("\n")) {
		const w = line.match(/\bwindow (window:\d+)(?:\s+([0-9A-Fa-f-]{36}))?/);
		if (w && !line.includes("workspace")) {
			window = w[1];
			windowUuid = w[2] ?? null;
			continue;
		}
		const ws = line.match(/\bworkspace (workspace:\d+)(?:\s+([0-9A-Fa-f-]{36}))?/);
		if (ws) {
			workspace = ws[1];
			workspaceUuid = ws[2] ?? null;
			continue;
		}
		// pane level (newer cmux nests surfaces under panes): surfaces still
		// belong to the current workspace, so panes are skipped deliberately
		if (/\bpane (pane:\d+)/.test(line)) continue;
		// note: `--id-format both` is accepted but undocumented; if a future
		// cmux drops it, the UUID captures come back null and callers degrade
		// to ref-based selection / env-derived surface ids
		const s = line.match(/\bsurface (surface:\d+)(?:\s+([0-9A-Fa-f-]{36}))?/);
		if (s && workspace) {
			const tty = line.match(/\btty=(ttys\d+)/)?.[1];
			const entry = {
				window,
				windowUuid,
				workspace,
				workspaceUuid,
				surface: s[1],
				surfaceUuid: s[2] ?? null,
				tty: tty ? `/dev/${tty}` : null,
			};
			surfaces.push(entry);
			if (entry.tty) ttyMap.set(entry.tty, entry);
		}
	}
	// exact mapping: which claude session does each surface host?
	await Promise.all(
		surfaces.map(async (s) => {
			s.sessionId = await surfaceSessionId(s);
			if (s.sessionId) sessionMap.set(s.sessionId, s);
		}),
	);
	return { surfaces, ttyMap, sessionMap };
}

/**
 * Fallback mapping for surfaces whose tty cmux lost (restored workspaces):
 * `debug-terminals` reports each surface's cwd — match the session's cwd.
 */
export async function cmuxLocByCwd(cwd, state) {
	if (!cwd || !state.surfaces.length) return null;
	const out = await runCmux(["debug-terminals"]);
	if (!out) return null;
	let surfaceRef = null;
	for (const line of out.split("\n")) {
		const head = line.match(/^\[\d+\] (surface:\d+) .*\btree=1\b/);
		if (head) {
			surfaceRef = head[1];
			continue;
		}
		if (line.startsWith("[")) {
			surfaceRef = null;
			continue;
		}
		const c = line.match(/\bcwd=(.*?) branch=/);
		if (c && surfaceRef && c[1] === cwd) {
			const ref = surfaceRef;
			return state.surfaces.find((s) => s.surface === ref) ?? null;
		}
	}
	return null;
}

/**
 * Bring the exact surface hosting the session to the front. The surface.focus
 * RPC selects the surface, its pane/tab, and its workspace — important when a
 * workspace hosts several claude sessions in splits or tabs.
 */
async function cmuxSurfaceIsCurrent(surfaceUuid) {
	const out = await runCmux(["rpc", "surface.current", "{}"]);
	try {
		return JSON.parse(out).surface_id === surfaceUuid;
	} catch {
		return false;
	}
}

/**
 * Tab-selection fallback for cmux builds where `surface.focus` focuses the
 * pane but leaves a sibling tab selected: cmux's own notification-jump path
 * always reveals the exact surface. The temporary notification is dismissed
 * immediately after the jump.
 */
async function cmuxRevealViaNotification(surfaceUuid) {
	const title = `claude-deck-jump-${Date.now().toString(36)}`;
	if ((await runCmux(["notify", "--title", title, "--surface", surfaceUuid])) === null) {
		return false;
	}
	const list = (await runCmux(["list-notifications"])) ?? "";
	const lines = list.split("\n");
	const at = lines.findIndex((l) => l.includes(title));
	let id = null;
	for (let i = Math.max(0, at - 2); at >= 0 && i <= Math.min(lines.length - 1, at + 2); i++) {
		id = lines[i].match(UUID_RE)?.[0] ?? id;
		if (id) break;
	}
	if (!id) return false;
	const ok = (await runCmux(["open-notification", "--id", id])) !== null;
	await runCmux(["dismiss-notification", "--id", id]);
	return ok;
}

export async function cmuxFocus(loc) {
	let windowUuid = loc.windowUuid ?? null;
	let ok = false;
	if (loc.surfaceUuid) {
		const out = await runCmux([
			"rpc",
			"surface.focus",
			JSON.stringify({ surface_id: loc.surfaceUuid }),
		]);
		ok = out !== null;
		// the RPC reports where the surface lives — needed to raise the right
		// window when the caller only knew the surface (env-derived locs)
		if (ok && !windowUuid) {
			try {
				windowUuid = JSON.parse(out).window_id ?? null;
			} catch {}
		}
		// some builds focus the pane but keep a sibling tab selected — verify,
		// and reveal through the notification-jump path when that happens
		if (ok && !(await cmuxSurfaceIsCurrent(loc.surfaceUuid))) {
			log(`cmuxFocus: sibling tab stayed selected; using notification jump for ${loc.surfaceUuid}`);
			await cmuxRevealViaNotification(loc.surfaceUuid);
		}
	}
	if (!ok) {
		// fallback: workspace-level selection
		const ws = loc.workspaceUuid ?? loc.workspace;
		if ((await runCmux(["select-workspace", "--workspace", ws])) === null) return false;
	}
	// focus-window requires the UUID form; skip it (single-window case) if unknown
	if (windowUuid) await runCmux(["focus-window", "--window", windowUuid]);
	await run("open", ["-a", CMUX_APP]);
	return true;
}

/** Send a key (e.g. "enter", "escape") straight to a cmux surface — no focus needed. */
export async function cmuxSendKey(loc, key) {
	return (
		(await runCmux(["send-key", "--surface", loc.surfaceUuid ?? loc.surface, key])) !== null
	);
}

/** Resume a session in a new cmux workspace. */
export async function cmuxResume(session) {
	const out = await runCmux([
		"new-workspace",
		"--name",
		session.name,
		"--cwd",
		session.cwd,
		"--command",
		`claude --resume ${session.id}`,
	]);
	if (out === null) return false;
	await run("open", ["-a", CMUX_APP]);
	return true;
}

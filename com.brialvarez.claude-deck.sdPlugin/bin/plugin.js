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
import fs from "node:fs";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = path.join(PLUGIN_DIR, "logs", "claude-deck.log");
try {
	fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {}

function log(msg) {
	try {
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
	} catch {}
}

process.on("uncaughtException", (err) => {
	log(`uncaught: ${err?.stack ?? err}`);
	process.exit(1);
});
process.on("unhandledRejection", (err) => {
	log(`unhandledRejection: ${err?.stack ?? err}`);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const EVENTS_FILE = path.join(os.homedir(), ".claude", "claude-deck", "events.jsonl");
const REFRESH_MS = 5_000;
const ACTIVE_WINDOW_MS = 5 * 60_000; // session is "active" if its file changed in the last 5 min
const RUNNING_WINDOW_MS = 60_000; // "running" if written to in the last minute
const RETAIN_MS = 8 * 24 * 3_600_000; // keep 8 days of usage entries
const SESSION_LIST_WINDOW_MS = 24 * 3_600_000; // sessions idle longer than this leave the deck
const LONG_PRESS_MS = 600; // hold a Session key this long to dismiss it from the deck
const HIDDEN_FILE = path.join(os.homedir(), ".claude", "claude-deck", "hidden.json");

const ACTION_SESSION = "com.brialvarez.claude-deck.session";
const ACTION_APPROVE = "com.brialvarez.claude-deck.approve";
const ACTION_DENY = "com.brialvarez.claude-deck.deny";
const ACTION_SESSIONS = "com.brialvarez.claude-deck.sessions";
const ACTION_USAGE = "com.brialvarez.claude-deck.usage";
const ACTION_LIMITS = "com.brialvarez.claude-deck.limits";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const LIMITS_REFRESH_MS = 60_000;

// Pricing per million tokens: [substring match, input, output].
// Cache writes bill at 1.25x input (5-minute TTL), cache reads at 0.1x input.
const PRICING = [
	["fable", 10, 50],
	["mythos", 10, 50],
	["opus", 5, 25],
	["sonnet", 3, 15],
	["haiku", 1, 5],
];

function ratesFor(model) {
	const m = String(model ?? "").toLowerCase();
	for (const [key, inp, out] of PRICING) {
		if (m.includes(key)) return { inp, out };
	}
	return { inp: 5, out: 25 }; // unknown models: assume Opus-tier
}

// ---------------------------------------------------------------------------
// Waiting-state store (fed by the Claude Code Notification hook)
// ---------------------------------------------------------------------------
// The hook appends {"t":<epoch-s>,"event":{...}} lines to EVENTS_FILE whenever
// Claude Code needs permission or is waiting for input. A session stops
// "waiting" as soon as its transcript grows again.

const waiting = new Map(); // sessionId -> { t (ms), kind: "permission"|"input", message }

// Sessions dismissed from the deck via long-press. A dismissed session
// reappears automatically when its transcript shows new activity.
const hidden = new Map(); // sessionId -> mtime at dismissal
try {
	for (const [id, m] of Object.entries(JSON.parse(fs.readFileSync(HIDDEN_FILE, "utf8")))) {
		hidden.set(id, m);
	}
} catch {}

function saveHidden() {
	try {
		fs.mkdirSync(path.dirname(HIDDEN_FILE), { recursive: true });
		fs.writeFileSync(HIDDEN_FILE, JSON.stringify(Object.fromEntries(hidden)));
	} catch (err) {
		log(`saveHidden failed: ${err?.message ?? err}`);
	}
}

class EventsWatcher {
	offset = 0;
	remainder = "";

	poll() {
		let stat;
		try {
			stat = fs.statSync(EVENTS_FILE);
		} catch {
			return;
		}
		if (stat.size < this.offset) {
			this.offset = 0;
			this.remainder = "";
		}
		if (stat.size === this.offset) return;

		const length = stat.size - this.offset;
		const buf = Buffer.allocUnsafe(length);
		let fd;
		try {
			fd = fs.openSync(EVENTS_FILE, "r");
			fs.readSync(fd, buf, 0, length, this.offset);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		this.offset = stat.size;

		const text = this.remainder + buf.toString("utf8");
		const lines = text.split("\n");
		this.remainder = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			const ev = obj.event ?? obj;
			const sid = ev.session_id;
			if (!sid) continue;
			const message = String(ev.message ?? "");
			const kind = /permission/i.test(message) ? "permission" : "input";
			waiting.set(sid, { t: (obj.t ?? Date.now() / 1000) * 1000, kind, message });
		}
	}
}

const eventsWatcher = new EventsWatcher();

// ---------------------------------------------------------------------------
// Usage + session collector — incremental JSONL reader over ~/.claude/projects
// ---------------------------------------------------------------------------

class UsageMonitor {
	files = new Map(); // path -> { offset, remainder, sessionId, cwd }
	entries = []; // { t, cost, tokens }
	seen = new Set(); // dedup keys (requestId:messageId)
	sessionMeta = new Map(); // sessionId -> { cwd, mtime, path }
	initialScanDone = false;

	scan() {
		try {
			this.#scanInner();
		} catch (err) {
			log(`scan failed: ${err?.message ?? err}`);
		}
	}

	#scanInner() {
		const now = Date.now();
		this.sessionMeta.clear();

		let projectDirs = [];
		try {
			projectDirs = fs.readdirSync(PROJECTS_DIR);
		} catch {
			return;
		}

		for (const dir of projectDirs) {
			const projectPath = path.join(PROJECTS_DIR, dir);
			let names;
			try {
				names = fs.readdirSync(projectPath);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const filePath = path.join(projectPath, name);
				let stat;
				try {
					stat = fs.statSync(filePath);
				} catch {
					continue;
				}
				if (now - stat.mtimeMs > RETAIN_MS) continue;

				const sessionId = name.slice(0, -6);
				let state = this.files.get(filePath);
				if (!state || stat.size < state.offset) {
					state = { offset: 0, remainder: "", sessionId, cwd: null };
					this.files.set(filePath, state);
				}
				if (stat.size > state.offset) {
					this.#readAppended(filePath, state, stat.size);
					// transcript grew -> the session is no longer waiting on us
					if (this.initialScanDone) waiting.delete(sessionId);
				}

				this.sessionMeta.set(sessionId, {
					cwd: state.cwd,
					mtime: stat.mtimeMs,
					path: filePath,
				});
			}
		}

		// prune old entries + stale file state
		const cutoff = now - RETAIN_MS;
		if (this.entries.length && this.entries[0].t < cutoff) {
			this.entries = this.entries.filter((e) => e.t >= cutoff);
		}
		for (const [key, state] of this.files) {
			if (!this.sessionMeta.has(state.sessionId)) this.files.delete(key);
		}

		if (!this.initialScanDone) {
			this.initialScanDone = true;
			// Reconcile waiting flags loaded from event history: a session whose
			// transcript changed after the event fired has already been handled.
			for (const [sid, w] of waiting) {
				const meta = this.sessionMeta.get(sid);
				if (!meta || meta.mtime > w.t + 2_000 || now - w.t > 12 * 3_600_000) {
					waiting.delete(sid);
				}
			}
		}
	}

	#readAppended(filePath, state, size) {
		const length = size - state.offset;
		const buf = Buffer.allocUnsafe(length);
		let fd;
		try {
			fd = fs.openSync(filePath, "r");
			fs.readSync(fd, buf, 0, length, state.offset);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		state.offset = size;

		const text = state.remainder + buf.toString("utf8");
		const lines = text.split("\n");
		state.remainder = lines.pop() ?? "";

		for (const line of lines) {
			if (!state.cwd && line.includes('"cwd"')) {
				try {
					const o = JSON.parse(line);
					if (o.cwd) state.cwd = o.cwd;
				} catch {}
			}
			if (!line.includes('"usage"')) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			if (obj.cwd && !state.cwd) state.cwd = obj.cwd;
			const usage = obj?.message?.usage;
			if (!usage) continue;
			const model = obj.message.model;
			if (!model || model === "<synthetic>") continue;

			const msgId = obj.message.id;
			if (msgId) {
				const key = `${obj.requestId ?? ""}:${msgId}`;
				if (this.seen.has(key)) continue;
				this.seen.add(key);
			}

			const t = Date.parse(obj.timestamp ?? "") || Date.now();
			const inp = usage.input_tokens ?? 0;
			const out = usage.output_tokens ?? 0;
			const cw = usage.cache_creation_input_tokens ?? 0;
			const cr = usage.cache_read_input_tokens ?? 0;
			const r = ratesFor(model);
			const cost =
				(inp * r.inp + out * r.out + cw * r.inp * 1.25 + cr * r.inp * 0.1) / 1e6;

			this.entries.push({ t, cost, tokens: inp + out + cw + cr });
		}
	}

	totals(since) {
		let cost = 0;
		let tokens = 0;
		for (const e of this.entries) {
			if (e.t >= since) {
				cost += e.cost;
				tokens += e.tokens;
			}
		}
		return { cost, tokens };
	}

	activeSessionCount() {
		const cutoff = Date.now() - ACTIVE_WINDOW_MS;
		let n = 0;
		for (const meta of this.sessionMeta.values()) {
			if (meta.mtime >= cutoff) n++;
		}
		return n;
	}

	todaySessionCount() {
		const startOfDay = new Date().setHours(0, 0, 0, 0);
		let n = 0;
		for (const meta of this.sessionMeta.values()) {
			if (meta.mtime >= startOfDay) n++;
		}
		return n;
	}

	/**
	 * Sessions for the per-session keys: permission-waiters first (oldest
	 * first, so approve/deny targets slot 1), then input-waiters, then by
	 * recency.
	 */
	sessionList() {
		const now = Date.now();
		const list = [];
		for (const [id, meta] of this.sessionMeta) {
			const w = waiting.get(id) ?? null;
			// dismissed via long-press: hidden until the transcript grows again
			const hiddenAt = hidden.get(id);
			if (hiddenAt !== undefined) {
				if (meta.mtime > hiddenAt + 1_500) {
					hidden.delete(id);
					saveHidden();
				} else {
					continue;
				}
			}
			// idle sessions age off the deck (waiting ones always show)
			if (!w && now - meta.mtime > SESSION_LIST_WINDOW_MS) continue;
			let stateName = "idle";
			if (w) stateName = w.kind === "permission" ? "needs-ok" : "input";
			else if (now - meta.mtime < RUNNING_WINDOW_MS) stateName = "running";
			list.push({
				id,
				cwd: meta.cwd,
				name: meta.cwd ? path.basename(meta.cwd) : id.slice(0, 8),
				mtime: meta.mtime,
				waiting: w,
				state: stateName,
			});
		}
		list.sort((a, b) => {
			const rank = (s) =>
				s.waiting ? (s.waiting.kind === "permission" ? 0 : 1) : 2;
			if (rank(a) !== rank(b)) return rank(a) - rank(b);
			if (a.waiting && b.waiting) return a.waiting.t - b.waiting.t;
			return b.mtime - a.mtime;
		});
		return list;
	}

	approvalTarget() {
		return this.sessionList().find((s) => s.waiting?.kind === "permission") ?? null;
	}
}

const monitor = new UsageMonitor();

// ---------------------------------------------------------------------------
// Terminal integration (macOS: Terminal.app + iTerm2)
// ---------------------------------------------------------------------------

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 8_000 }, (err, stdout, stderr) => {
			if (err) {
				if (cmd === CMUX_BIN) {
					log(
						`cmux ${args[0]} failed: ${err.code ?? ""} ${err.message?.split("\n")[0] ?? ""} stderr=${String(stderr ?? "").trim().slice(0, 300)}`,
					);
				}
				resolve(null);
				return;
			}
			resolve(String(stdout));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isRunning(processName) {
	return (await run("pgrep", ["-x", processName])) !== null;
}

let procCache = { t: 0, procs: [] };

/** Running `claude` CLI processes: [{ pid, tty, cwd }] */
async function claudeProcesses() {
	if (Date.now() - procCache.t < 10_000) return procCache.procs;
	const out = await run("ps", ["-axo", "pid=,tty=,command="]);
	const procs = [];
	if (out) {
		for (const line of out.split("\n")) {
			const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
			if (!m) continue;
			const [, pid, tty, command] = m;
			// match only when the executable itself is `claude` (not e.g.
			// cmux's "hooks feed --source claude" helpers)
			const exe = command.split(" ", 1)[0];
			if (!/(^|\/)claude$/.test(exe)) continue;
			// headless processes (tty "??") still count as "running" for duplicate-guarding
			const devTty = tty === "??" || tty === "-" ? null : `/dev/${tty}`;
			procs.push({ pid: Number(pid), tty: devTty, cwd: null });
		}
	}
	if (procs.length) {
		// one lsof call for all pids; -w suppresses per-pid warnings
		const out2 = await run("lsof", [
			"-w",
			"-a",
			"-p",
			procs.map((p) => p.pid).join(","),
			"-d",
			"cwd",
			"-Fpn",
		]);
		if (out2) {
			let pid = null;
			for (const line of out2.split("\n")) {
				if (line.startsWith("p")) pid = Number(line.slice(1));
				else if (line.startsWith("n")) {
					const p = procs.find((x) => x.pid === pid);
					if (p) p.cwd = line.slice(1);
				}
			}
		} else {
			log("claudeProcesses: lsof failed or timed out");
		}
	}
	procCache = { t: Date.now(), procs };
	return procs;
}

/**
 * Where is this session running?
 *   { loc }        — inside a cmux surface (preferred match)
 *   { tty }        — on a plain terminal tty, not in cmux
 *   { running }    — process exists but is headless/unfocusable
 *   {}             — not running
 * Several claude processes can share a cwd (e.g. orphans left by a force
 * quit), so prefer the one that actually has a cmux surface.
 */
async function locateSession(session, state) {
	if (!session?.cwd) return {};
	const procs = await claudeProcesses();
	const matches = procs.filter((p) => p.cwd === session.cwd);
	if (!matches.length) {
		log(
			`locateSession: no process for ${session.cwd}; procs=${JSON.stringify(
				procs.map((p) => ({ pid: p.pid, tty: p.tty, cwd: p.cwd })),
			)}`,
		);
		return {};
	}
	const inMap = matches.find((p) => state.ttyMap.has(p.tty));
	if (inMap) return { loc: state.ttyMap.get(inMap.tty), tty: inMap.tty, running: true };
	// cmux may have lost the surface's tty (restored workspace) — match by cwd
	const byCwd = await cmuxLocByCwd(session.cwd, state);
	if (byCwd) return { loc: byCwd, tty: matches[0].tty ?? null, running: true };
	return { tty: matches[0].tty ?? null, running: true };
}

function osaEsc(s) {
	return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Focus the Terminal.app / iTerm2 tab hosting `tty`. True on success. */
async function focusTty(tty) {
	if (await isRunning("iTerm2")) {
		const script =
			`tell application "iTerm2"\n` +
			`repeat with w in windows\n` +
			`repeat with tb in tabs of w\n` +
			`repeat with s in sessions of tb\n` +
			`if (tty of s) is "${osaEsc(tty)}" then\n` +
			`select s\nselect tb\nselect w\nactivate\nreturn "ok"\n` +
			`end if\nend repeat\nend repeat\nend repeat\nend tell\nreturn "notfound"`;
		const out = await run("osascript", ["-e", script]);
		if (out?.trim() === "ok") return true;
	}
	if (await isRunning("Terminal")) {
		const script =
			`tell application "Terminal"\n` +
			`repeat with w in windows\n` +
			`repeat with t in tabs of w\n` +
			`if (tty of t) is "${osaEsc(tty)}" then\n` +
			`set selected tab of w to t\nset index of w to 1\nactivate\nreturn "ok"\n` +
			`end if\nend repeat\nend repeat\nend tell\nreturn "notfound"`;
		const out = await run("osascript", ["-e", script]);
		if (out?.trim() === "ok") return true;
	}
	return false;
}

/** Open a new terminal that resumes `session` in its project directory. */
async function openResume(session) {
	if (!session?.cwd) return false;
	const shell = `cd ${shq(session.cwd)} && claude --resume ${shq(session.id)}`;
	if (await isRunning("iTerm2")) {
		const script =
			`tell application "iTerm2"\n` +
			`set w to (create window with default profile)\n` +
			`tell current session of w to write text "${osaEsc(shell)}"\n` +
			`activate\nend tell`;
		return (await run("osascript", ["-e", script])) !== null;
	}
	const script =
		`tell application "Terminal"\n` +
		`do script "${osaEsc(shell)}"\n` +
		`activate\nend tell`;
	return (await run("osascript", ["-e", script])) !== null;
}

/** key codes: 36 = Return, 53 = Escape */
async function pressKey(keyCode) {
	return (
		(await run("osascript", [
			"-e",
			`tell application "System Events" to key code ${keyCode}`,
		])) !== null
	);
}

// ---------------------------------------------------------------------------
// cmux integration — sessions running inside cmux.app
// ---------------------------------------------------------------------------

function cmuxAvailable() {
	try {
		fs.accessSync(CMUX_BIN, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

let cmuxPwCache = { t: 0, pw: null };

/**
 * cmux socket password from ~/.local/state/cmux/socket-control-password.
 * cmux's socket defaults to cmuxOnly access (descendant processes only); in
 * "password" mode external processes (like this plugin) authenticate with the
 * password stored in that file — the documented location the cmux app itself
 * reads and watches.
 */
function cmuxPassword() {
	if (Date.now() - cmuxPwCache.t < 60_000) return cmuxPwCache.pw;
	let pw = null;
	try {
		pw =
			fs
				.readFileSync(
					path.join(os.homedir(), ".local", "state", "cmux", "socket-control-password"),
					"utf8",
				)
				.trim() || null;
	} catch {}
	cmuxPwCache = { t: Date.now(), pw };
	return pw;
}

function runCmux(args) {
	const pw = cmuxPassword();
	return new Promise((resolve) => {
		execFile(
			CMUX_BIN,
			args,
			{
				timeout: 8_000,
				env: pw ? { ...process.env, CMUX_SOCKET_PASSWORD: pw } : process.env,
			},
			(err, stdout, stderr) => {
				if (err) {
					log(
						`cmux ${args[0]} failed: ${err.code ?? ""} ${err.message?.split("\n")[0] ?? ""} stderr=${String(stderr ?? "").trim().slice(0, 200)}`,
					);
					resolve(null);
					return;
				}
				resolve(String(stdout));
			},
		);
	});
}

/**
 * Parse `cmux tree --all --id-format both` into
 * tty -> { window, windowUuid, workspace, surface }.
 * Tree lines look like:
 *   window window:1 AE04...73 [current]
 *   ├── workspace workspace:3 B21D...07 "title" [selected]
 *   │       └── surface surface:12 4AA9...13 [terminal] "title" tty=ttys000
 */
/**
 * Snapshot of cmux surfaces: { surfaces: [...], ttyMap: Map(tty -> surface) }.
 * Each surface: { surface, surfaceUuid, workspace, workspaceUuid, window,
 * windowUuid, tty|null }. Restored surfaces sometimes report no tty — those
 * can still be matched by cwd via cmuxLocByCwd().
 */
async function cmuxState() {
	const out = await runCmux(["tree", "--all", "--id-format", "both"]);
	const surfaces = [];
	const ttyMap = new Map();
	if (!out) return { surfaces, ttyMap };
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
	return { surfaces, ttyMap };
}

/**
 * Fallback mapping for surfaces whose tty cmux lost (restored workspaces):
 * `debug-terminals` reports each surface's cwd — match the session's cwd.
 */
async function cmuxLocByCwd(cwd, state) {
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


/** Bring the cmux workspace hosting the session to the front. */
async function cmuxFocus(loc) {
	// UUIDs are stable; short refs (workspace:N) renumber as workspaces close
	const ws = loc.workspaceUuid ?? loc.workspace;
	if ((await runCmux(["select-workspace", "--workspace", ws])) === null) return false;
	// focus-window requires the UUID form; skip it (single-window case) if unknown
	if (loc.windowUuid) await runCmux(["focus-window", "--window", loc.windowUuid]);
	await run("open", ["-a", "/Applications/cmux.app"]);
	return true;
}

/** Send a key (e.g. "enter", "escape") straight to a cmux surface — no focus needed. */
async function cmuxSendKey(loc, key) {
	return (
		(await runCmux(["send-key", "--surface", loc.surfaceUuid ?? loc.surface, key])) !== null
	);
}

/** Resume a session in a new cmux workspace. */
async function cmuxResume(session) {
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
	await run("open", ["-a", "/Applications/cmux.app"]);
	return true;
}

// ---------------------------------------------------------------------------
// Plan limits — the same numbers `/usage` shows (OAuth usage endpoint)
// ---------------------------------------------------------------------------

class ClaudeLimits {
	rows = null; // [{ label, percent, resetsAt, active }]
	fetchedAt = 0;
	#token = null;
	#tokenAt = 0;
	#nextAttempt = 0;
	#backoffLogged = false;

	async #getToken() {
		if (this.#token && Date.now() - this.#tokenAt < 10 * 60_000) return this.#token;
		let raw = await run("security", [
			"find-generic-password",
			"-s",
			"Claude Code-credentials",
			"-w",
		]);
		if (!raw) {
			try {
				raw = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
			} catch {
				return null;
			}
		}
		try {
			this.#token = JSON.parse(raw).claudeAiOauth?.accessToken ?? null;
			this.#tokenAt = Date.now();
		} catch {
			this.#token = null;
		}
		return this.#token;
	}

	#request(token) {
		return new Promise((resolve) => {
			const req = https.request(
				{
					hostname: "api.anthropic.com",
					path: "/api/oauth/usage",
					method: "GET",
					timeout: 10_000,
					headers: {
						Authorization: `Bearer ${token}`,
						"anthropic-beta": "oauth-2025-04-20",
						"Content-Type": "application/json",
					},
				},
				(res) => {
					let body = "";
					res.on("data", (c) => (body += c));
					res.on("end", () => resolve({ status: res.statusCode, body }));
				},
			);
			req.on("error", (err) => {
				log(`limits https error: ${err?.code ?? ""} ${err?.message ?? err}`);
				resolve(this.#requestViaCurl(token)); // fallback path
			});
			req.on("timeout", () => {
				req.destroy();
				resolve(this.#requestViaCurl(token));
			});
			req.end();
		});
	}

	/** Fallback for environments where the plugin process's own sockets are filtered. */
	async #requestViaCurl(token) {
		const out = await run("curl", [
			"-s",
			"-w",
			"\n%{http_code}",
			"--max-time",
			"10",
			"https://api.anthropic.com/api/oauth/usage",
			"-H",
			`Authorization: Bearer ${token}`,
			"-H",
			"anthropic-beta: oauth-2025-04-20",
			"-H",
			"Content-Type: application/json",
		]);
		if (!out) return null;
		const nl = out.lastIndexOf("\n");
		const status = Number(out.slice(nl + 1).trim());
		if (!status) return null;
		return { status, body: out.slice(0, nl) };
	}

	async refresh(force = false) {
		if (!force && Date.now() < this.#nextAttempt) return;
		const token = await this.#getToken();
		if (!token) return;
		let res = await this.#request(token);
		if (res?.status === 401) {
			this.#token = null; // token rotated — re-read from keychain once
			const fresh = await this.#getToken();
			if (fresh) res = await this.#request(fresh);
		}
		if (res?.status === 429) {
			// rate limited — keep last data, back off for 10 minutes
			this.#nextAttempt = Date.now() + 10 * 60_000;
			if (!this.#backoffLogged) {
				log("limits: 429 rate limited, backing off to 10 min interval");
				this.#backoffLogged = true;
			}
			return;
		}
		if (!res || res.status !== 200) {
			log(`limits fetch failed: ${res?.status ?? "network"}`);
			this.#nextAttempt = Date.now() + 2 * 60_000;
			return;
		}
		this.#backoffLogged = false;
		this.#nextAttempt = Date.now() + 2 * 60_000; // polite base interval
		try {
			const data = JSON.parse(res.body);
			const rows = [];
			for (const l of data.limits ?? []) {
				if (typeof l.percent !== "number") continue;
				let label;
				if (l.kind === "session") label = "5 HR";
				else if (l.kind === "weekly_all") label = "WEEK";
				else label = (l.scope?.model?.display_name ?? l.kind ?? "?").toUpperCase();
				rows.push({
					label,
					percent: Math.round(l.percent),
					resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
					active: Boolean(l.is_active),
				});
			}
			if (rows.length) {
				this.rows = rows.slice(0, 3);
				this.fetchedAt = Date.now();
			}
		} catch (err) {
			log(`limits parse failed: ${err?.message ?? err}`);
		}
	}
}

const limits = new ClaudeLimits();

// ---------------------------------------------------------------------------
// Key face rendering (SVG -> data URI)
// ---------------------------------------------------------------------------

const FG = "#f4f2ee";
const DIM = "#7f7f92";
const ACCENT = "#d97757";
const GREEN = "#34d399";
const AMBER = "#fbbf24";
const BLUE = "#60a5fa";
const RED = "#f87171";
const GRAY = "#4b4b58";
const FONTS = `-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function svgWrap(inner) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<defs>` +
		`<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
		`<stop offset="0" stop-color="#1d1d29"/><stop offset="1" stop-color="#0f0f16"/>` +
		`</linearGradient>` +
		`</defs>` +
		`<rect width="144" height="144" rx="20" fill="url(#bg)"/>` +
		inner +
		`</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function fitFont(text, max, box = 116) {
	const size = Math.floor(box / (0.58 * Math.max(1, String(text).length)));
	return Math.max(13, Math.min(max, size));
}

function truncate(s, n) {
	s = String(s);
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function glowDot(cx, cy, color) {
	return (
		`<circle cx="${cx}" cy="${cy}" r="12" fill="${color}" opacity="0.18"/>` +
		`<circle cx="${cx}" cy="${cy}" r="6" fill="${color}"/>`
	);
}

/** Generic stat face: label / big value / sub-line. */
function statFace({ label, value, sub, dot, valueColor = FG, valueSize = 44 }) {
	return svgWrap(
		`<rect x="0" y="0" width="144" height="4" rx="2" fill="${ACCENT}" opacity="0.85"/>` +
			(dot ? glowDot(120, 28, dot) : "") +
			`<text x="16" y="34" font-family="${FONTS}" font-size="14" font-weight="600" letter-spacing="2" fill="${DIM}">${esc(label)}</text>` +
			`<text x="72" y="90" text-anchor="middle" font-family="${FONTS}" font-size="${valueSize}" font-weight="700" fill="${valueColor}">${esc(value)}</text>` +
			`<text x="72" y="124" text-anchor="middle" font-family="${FONTS}" font-size="16" fill="${DIM}">${esc(sub)}</text>`,
	);
}

const SESSION_STATES = {
	running: { color: GREEN, label: "RUNNING" },
	"needs-ok": { color: AMBER, label: "NEEDS OK" },
	input: { color: BLUE, label: "INPUT?" },
	idle: { color: GRAY, label: "IDLE" },
};

function ago(mtime) {
	const s = Math.max(0, (Date.now() - mtime) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

function sessionFace(session) {
	if (!session) {
		return svgWrap(
			`<text x="72" y="82" text-anchor="middle" font-family="${FONTS}" font-size="34" fill="#33333e">·</text>`,
		);
	}
	const st = SESSION_STATES[session.state];
	const name = truncate(session.name, 14);
	const size = fitFont(name, 26);
	const pulse =
		session.state === "needs-ok" || session.state === "input"
			? `<rect x="0" y="0" width="144" height="144" rx="20" fill="none" stroke="${st.color}" stroke-width="3" opacity="0.65"/>`
			: "";
	return svgWrap(
		`<rect x="0" y="0" width="144" height="5" rx="2.5" fill="${st.color}"/>` +
			pulse +
			glowDot(120, 28, st.color) +
			`<text x="16" y="34" font-family="${FONTS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${st.color}">${esc(st.label)}</text>` +
			`<text x="72" y="86" text-anchor="middle" font-family="${FONTS}" font-size="${size}" font-weight="700" fill="${FG}">${esc(name)}</text>` +
			`<text x="72" y="122" text-anchor="middle" font-family="${FONTS}" font-size="15" fill="${DIM}">${esc(ago(session.mtime))}</text>`,
	);
}

function approveFace(target) {
	const active = Boolean(target);
	const color = active ? GREEN : "#2e4038";
	return svgWrap(
		`<path d="M44 74 L64 94 L102 52" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
			`<text x="72" y="126" text-anchor="middle" font-family="${FONTS}" font-size="16" font-weight="600" fill="${active ? FG : DIM}">${esc(active ? truncate(target.name, 13) : "—")}</text>`,
	);
}

function denyFace(target) {
	const active = Boolean(target);
	const color = active ? RED : "#453032";
	return svgWrap(
		`<path d="M50 50 L94 94 M94 50 L50 94" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round"/>` +
			`<text x="72" y="126" text-anchor="middle" font-family="${FONTS}" font-size="16" font-weight="600" fill="${active ? FG : DIM}">${esc(active ? truncate(target.name, 13) : "—")}</text>`,
	);
}

/**
 * Mini session list for the "Active Sessions" key: up to 4 rows (state dot +
 * name), highlighting the rows currently shown on the Session slot keys.
 * Press pages the Session keys through the whole list.
 */
function sessionsListFace(sessions, offset) {
	const active = monitor.activeSessionCount();
	const today = monitor.todaySessionCount();
	const pages = sessionPageCount();
	const header =
		pages > 1 ? `SESSIONS ${sessionPage + 1}/${pages}` : "SESSIONS";
	let inner =
		`<rect x="0" y="0" width="144" height="4" rx="2" fill="${ACCENT}" opacity="0.85"/>` +
		`<text x="14" y="26" font-family="${FONTS}" font-size="13" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc(header)}</text>`;
	const slotCount = Math.max(1, sessionSlots().length);
	// scroll the 4-row window so the current page's sessions are visible
	const start = Math.min(offset, Math.max(0, sessions.length - 4));
	const shown = sessions.slice(start, start + 4);
	shown.forEach((s, i) => {
		const y = 46 + i * 20;
		const st = SESSION_STATES[s.state];
		const abs = start + i;
		const onDeck = abs >= offset && abs < offset + slotCount;
		inner +=
			`<circle cx="20" cy="${y - 4.5}" r="4.5" fill="${st.color}"/>` +
			`<text x="32" y="${y}" font-family="${FONTS}" font-size="14" font-weight="${onDeck ? 700 : 400}" fill="${onDeck ? FG : DIM}">${esc(truncate(s.name, 13))}</text>`;
	});
	if (!shown.length) {
		inner += `<text x="72" y="80" text-anchor="middle" font-family="${FONTS}" font-size="14" fill="${GRAY}">none</text>`;
	}
	if (sessions.length > start + 4) {
		inner += `<text x="130" y="26" text-anchor="end" font-family="${FONTS}" font-size="12" fill="${GRAY}">+${sessions.length - start - 4}</text>`;
	}
	inner += `<text x="72" y="132" text-anchor="middle" font-family="${FONTS}" font-size="13" fill="${DIM}">${active} active · ${today} today</text>`;
	return svgWrap(inner);
}

function limitColor(pct) {
	if (pct >= 85) return RED;
	if (pct >= 60) return AMBER;
	return GREEN;
}

function fmtResetTime(ms) {
	if (!ms) return "";
	const d = new Date(ms);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (sameDay) return hm;
	return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}

function limitsFace(rows, stale) {
	if (!rows) {
		return svgWrap(
			`<text x="72" y="60" text-anchor="middle" font-family="${FONTS}" font-size="16" font-weight="600" letter-spacing="2" fill="${DIM}">LIMITS</text>` +
				`<text x="72" y="92" text-anchor="middle" font-family="${FONTS}" font-size="15" fill="${GRAY}">no data yet</text>`,
		);
	}
	let inner = stale
		? `<circle cx="128" cy="16" r="4" fill="${AMBER}" opacity="0.8"/>`
		: "";
	const n = rows.length;
	const rowH = n === 3 ? 44 : 56;
	const top = n === 3 ? 8 : 18;
	rows.forEach((r, i) => {
		const y = top + i * rowH;
		const color = limitColor(r.percent);
		const barW = Math.max(3, Math.round((116 * Math.min(100, r.percent)) / 100));
		const reset = r.label === "5 HR" && r.resetsAt ? ` · ${fmtResetTime(r.resetsAt)}` : "";
		inner +=
			`<text x="14" y="${y + 18}" font-family="${FONTS}" font-size="13" font-weight="600" letter-spacing="1" fill="${DIM}">${esc(r.label + reset)}</text>` +
			`<text x="130" y="${y + 18}" text-anchor="end" font-family="${FONTS}" font-size="16" font-weight="700" fill="${color}">${r.percent}%</text>` +
			`<rect x="14" y="${y + 25}" width="116" height="9" rx="4.5" fill="#2a2a36"/>` +
			`<rect x="14" y="${y + 25}" width="${barW}" height="9" rx="4.5" fill="${color}"/>`;
	});
	return svgWrap(inner);
}

function fmtCost(cost) {
	if (cost >= 100) return `$${Math.round(cost)}`;
	return `$${cost.toFixed(2)}`;
}

function fmtTokens(tokens) {
	if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B tok`;
	if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M tok`;
	if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k tok`;
	return `${tokens} tok`;
}

// ---------------------------------------------------------------------------
// Standalone test mode: `node bin/plugin.js --test`
// ---------------------------------------------------------------------------

const WINDOWS = [
	{ label: "TODAY", since: () => new Date().setHours(0, 0, 0, 0) },
	{ label: "LAST 5H", since: () => Date.now() - 5 * 3_600_000 },
	{ label: "7 DAYS", since: () => Date.now() - 7 * 24 * 3_600_000 },
];

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
	const procs = await claudeProcesses();
	console.log("claude processes:", JSON.stringify(procs));
	if (cmuxAvailable()) {
		const st = await cmuxState();
		console.log("cmux surfaces:", JSON.stringify(st.surfaces));
	}
	await limits.refresh();
	console.log("limits:", JSON.stringify(limits.rows));
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Minimal WebSocket client (RFC 6455, client side, text frames only)
// ---------------------------------------------------------------------------

class MiniWebSocket {
	#socket;
	#buffer = Buffer.alloc(0);
	#handshaken = false;
	onmessage = null;
	onopen = null;
	onclose = null;

	constructor(port) {
		const key = crypto.randomBytes(16).toString("base64");
		this.#socket = net.connect(port, "127.0.0.1", () => {
			this.#socket.write(
				`GET / HTTP/1.1\r\n` +
					`Host: 127.0.0.1:${port}\r\n` +
					`Upgrade: websocket\r\n` +
					`Connection: Upgrade\r\n` +
					`Sec-WebSocket-Key: ${key}\r\n` +
					`Sec-WebSocket-Version: 13\r\n\r\n`,
			);
		});
		this.#socket.on("data", (data) => this.#onData(data));
		this.#socket.on("error", (err) => log(`socket error: ${err.message}`));
		this.#socket.on("close", () => this.onclose?.());
	}

	#onData(data) {
		this.#buffer = Buffer.concat([this.#buffer, data]);

		if (!this.#handshaken) {
			const end = this.#buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			const header = this.#buffer.subarray(0, end).toString("latin1");
			this.#buffer = this.#buffer.subarray(end + 4);
			if (!/^HTTP\/1\.1 101/.test(header)) {
				log(`handshake failed: ${header.split("\r\n")[0]}`);
				this.#socket.destroy();
				return;
			}
			this.#handshaken = true;
			this.onopen?.();
		}

		for (;;) {
			if (this.#buffer.length < 2) return;
			const b0 = this.#buffer[0];
			const b1 = this.#buffer[1];
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this.#buffer.length < 4) return;
				len = this.#buffer.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (this.#buffer.length < 10) return;
				len = Number(this.#buffer.readBigUInt64BE(2));
				offset = 10;
			}
			const maskLen = masked ? 4 : 0;
			if (this.#buffer.length < offset + maskLen + len) return;

			let payload = this.#buffer.subarray(offset + maskLen, offset + maskLen + len);
			if (masked) {
				const mask = this.#buffer.subarray(offset, offset + 4);
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			}
			this.#buffer = this.#buffer.subarray(offset + maskLen + len);

			switch (opcode) {
				case 0x1:
					this.onmessage?.(payload.toString("utf8"));
					break;
				case 0x8:
					this.#sendFrame(0x8, payload);
					this.#socket.end();
					return;
				case 0x9:
					this.#sendFrame(0xa, payload);
					break;
				default:
					break;
			}
		}
	}

	#sendFrame(opcode, payload) {
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, 0x80 | len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		const mask = crypto.randomBytes(4);
		const maskedPayload = Buffer.from(payload);
		for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i & 3];
		this.#socket.write(Buffer.concat([header, mask, maskedPayload]));
	}

	sendJSON(obj) {
		if (!this.#handshaken) return;
		this.#sendFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
	}
}

// ---------------------------------------------------------------------------
// Stream Deck wiring
// ---------------------------------------------------------------------------

const argv = process.argv;
function arg(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const port = Number(arg("-port"));
const pluginUUID = arg("-pluginUUID");
const registerEvent = arg("-registerEvent");

if (!port || !pluginUUID || !registerEvent) {
	log(`bad launch args: ${argv.join(" ")}`);
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

const usageWindow = new Map(); // context -> window index
const pressStart = new Map(); // context -> keyDown timestamp (long-press detection)
let sessionPage = 0; // which page of sessions the Session slot keys show

/** Long-press on a Session key: hide the session until it has new activity. */
function dismissSession(context) {
	const session = sessionForContext(context);
	if (!session) {
		showAlert(context);
		return;
	}
	hidden.set(session.id, session.mtime);
	saveHidden();
	log(`dismissed session ${session.name} (${session.id.slice(0, 8)})`);
	renderAll();
	showOk(context);
}

function setImage(context, image) {
	ws.sendJSON({ event: "setImage", context, payload: { image, target: 0 } });
}

function showOk(context) {
	ws.sendJSON({ event: "showOk", context });
}

function showAlert(context) {
	ws.sendJSON({ event: "showAlert", context });
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
	if (sessionPage >= sessionPageCount()) sessionPage = 0;
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
		setImage(ctx, sessionsListFace(sessions, offset));
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

async function handleSessionPress(context) {
	const session = sessionForContext(context);
	if (!session) {
		showAlert(context);
		return;
	}
	const state = cmuxAvailable() ? await cmuxState() : { surfaces: [], ttyMap: new Map() };
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

/** decision: "approve" (enter/Return) or "deny" (escape) */
async function handleDecision(context, decision) {
	const target = monitor.approvalTarget();
	if (!target) {
		showAlert(context);
		return;
	}
	const state = cmuxAvailable() ? await cmuxState() : { surfaces: [], ttyMap: new Map() };
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
			break;
		}
		case "keyDown": {
			if (action === ACTION_SESSION) {
				// decided on keyUp: quick press = open/focus, long press = dismiss
				pressStart.set(context, Date.now());
			} else if (action === ACTION_APPROVE) {
				handleDecision(context, "approve");
			} else if (action === ACTION_DENY) {
				handleDecision(context, "deny");
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
					handleSessionPress(context);
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

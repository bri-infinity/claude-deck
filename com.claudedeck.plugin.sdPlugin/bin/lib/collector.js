// Session + usage collector: incrementally parses Claude Code transcripts
// (~/.claude/projects/*/*.jsonl) and the Notification-hook events file into
// the session list, waiting states, and usage totals the keys render.
import fs from "node:fs";
import path from "node:path";
import {
	PROJECTS_DIR,
	EVENTS_FILE,
	HIDDEN_FILE,
	RETAIN_MS,
	ACTIVE_WINDOW_MS,
	RUNNING_WINDOW_MS,
	SESSION_LIST_WINDOW_MS,
	ratesFor,
} from "./config.js";
import { log } from "./log.js";
import { readNewLines } from "./jsonl.js";

const SEEN_MAX = 60_000; // dedup-set cap; prune to SEEN_KEEP when exceeded
const SEEN_KEEP = 40_000;

// ---------------------------------------------------------------------------
// Waiting state (fed by the Claude Code Notification hook): a session is
// "waiting" from the moment a notification fires until its transcript grows.
// ---------------------------------------------------------------------------

export const waiting = new Map(); // sessionId -> { t (ms), kind: "permission"|"input", message }

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

/** Hide a session from the deck until it has new activity. */
export function dismissSessionId(id, mtime) {
	hidden.set(id, mtime);
	saveHidden();
}

class EventsWatcher {
	#state = { offset: 0, remainder: "" };

	poll() {
		let stat;
		try {
			stat = fs.statSync(EVENTS_FILE);
		} catch {
			return;
		}
		if (stat.size < this.#state.offset) {
			this.#state = { offset: 0, remainder: "" };
		}
		if (stat.size === this.#state.offset) return;

		for (const line of readNewLines(EVENTS_FILE, this.#state, stat.size)) {
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

export const eventsWatcher = new EventsWatcher();

// ---------------------------------------------------------------------------
// Usage monitor
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
			return; // no Claude Code data yet
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
					this.#ingest(filePath, state, stat.size);
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

		this.#prune(now);

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

	#ingest(filePath, state, size) {
		for (const line of readNewLines(filePath, state, size)) {
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
			// track the LATEST cwd — a resumed session may run from a different
			// directory than where it was born, and process matching needs the
			// current one
			if (obj.cwd) state.cwd = obj.cwd;
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

	#prune(now) {
		const cutoff = now - RETAIN_MS;
		if (this.entries.length && this.entries[0].t < cutoff) {
			this.entries = this.entries.filter((e) => e.t >= cutoff);
		}
		for (const [key, state] of this.files) {
			if (!this.sessionMeta.has(state.sessionId)) this.files.delete(key);
		}
		// the dedup set only needs to cover recently-read messages
		if (this.seen.size > SEEN_MAX) {
			const drop = this.seen.size - SEEN_KEEP;
			let i = 0;
			for (const key of this.seen) {
				if (i++ >= drop) break;
				this.seen.delete(key);
			}
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
	 * recency. Dismissed and long-idle sessions are excluded.
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
			const rank = (s) => (s.waiting ? (s.waiting.kind === "permission" ? 0 : 1) : 2);
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

export const monitor = new UsageMonitor();

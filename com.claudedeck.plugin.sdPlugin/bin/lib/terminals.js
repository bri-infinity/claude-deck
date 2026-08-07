// macOS terminal integration: claude process discovery, and Terminal.app /
// iTerm2 tab focusing + keystrokes via AppleScript.
import { run } from "./exec.js";
import { log } from "./log.js";

export function osaEsc(s) {
	return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function isRunning(processName) {
	return (await run("pgrep", ["-x", processName])) !== null;
}

let procCache = { t: 0, procs: [] };
const PROC_CACHE_MS = 10_000;

/** Running `claude` CLI processes: [{ pid, tty, cwd }] */
export async function claudeProcesses() {
	if (Date.now() - procCache.t < PROC_CACHE_MS) return procCache.procs;
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
			// resumed sessions expose their session id in argv — exact identity
			const sessionId =
				command
					.match(/--resume\s+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
					?.toLowerCase() ?? null;
			procs.push({ pid: Number(pid), tty: devTty, cwd: null, sessionId });
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

/** Focus the Terminal.app / iTerm2 tab hosting `tty`. True on success. */
export async function focusTty(tty) {
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
export async function openResume(session) {
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

/** Synthesize a keystroke; key codes: 36 = Return, 53 = Escape. */
export async function pressKey(keyCode) {
	return (
		(await run("osascript", [
			"-e",
			`tell application "System Events" to key code ${keyCode}`,
		])) !== null
	);
}

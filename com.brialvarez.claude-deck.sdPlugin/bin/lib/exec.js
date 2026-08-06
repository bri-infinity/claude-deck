// Small child-process helpers shared by terminal, cmux, and limits modules.
import { execFile } from "node:child_process";

export const EXEC_TIMEOUT_MS = 8_000;
// `ps -axo command=` can be large (Claude Code sessions carry multi-KB
// --settings arguments), so give child output generous headroom.
export const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run a command; resolves stdout on success, null on any failure.
 * Pass `onError(err, stderr)` when the caller wants failure details.
 */
export function run(cmd, args, { env, onError } = {}) {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, env },
			(err, stdout, stderr) => {
				if (err) {
					onError?.(err, String(stderr ?? ""));
					resolve(null);
					return;
				}
				resolve(String(stdout));
			},
		);
	});
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

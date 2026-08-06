// Incremental line reader for append-only files (Claude Code transcripts,
// the notification events file). Callers keep { offset, remainder } state.
import fs from "node:fs";

/**
 * Read bytes appended since `state.offset` (up to `size`) and return complete
 * lines; a trailing partial line is kept in `state.remainder` for next time.
 */
export function readNewLines(filePath, state, size) {
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
	return lines;
}

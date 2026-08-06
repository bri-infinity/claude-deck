// Append-only file logger with size-based rotation, plus process-level
// crash handlers (Stream Deck relaunches the plugin on exit).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(
	path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const LOG_FILE = path.join(PLUGIN_DIR, "logs", "claude-deck.log");
const MAX_LOG_BYTES = 512 * 1024;
const ROTATE_CHECK_EVERY = 500; // writes between size checks

let writesSinceCheck = 0;

try {
	fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {}

function rotateIfNeeded() {
	try {
		if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
			fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
		}
	} catch {}
}

rotateIfNeeded();

export function log(msg) {
	try {
		if (++writesSinceCheck >= ROTATE_CHECK_EVERY) {
			writesSinceCheck = 0;
			rotateIfNeeded();
		}
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

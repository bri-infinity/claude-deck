// Generates the README's example key-face images (docs/img/*.svg) using the
// plugin's real renderer, so the docs always match the actual design.
// Run: node gen-docs.mjs
import fs from "node:fs";
import path from "node:path";
import {
	statFace,
	sessionFace,
	approveFace,
	denyFace,
	sessionsListFace,
	limitsFace,
} from "./com.claudedeck.plugin.sdPlugin/bin/lib/faces.js";

const OUT = path.join(import.meta.dirname, "docs", "img");
fs.mkdirSync(OUT, { recursive: true });

function write(name, dataUri) {
	const svg = Buffer.from(dataUri.split(",")[1], "base64").toString("utf8");
	fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
	console.log(`wrote docs/img/${name}.svg`);
}

const now = Date.now();
const min = 60_000;

write(
	"session-running",
	sessionFace({ name: "api-server", state: "running", mtime: now - 0.5 * min }),
);
write(
	"session-needs-ok",
	sessionFace({ name: "webapp", state: "needs-ok", mtime: now - 2 * min }),
);
write(
	"session-input",
	sessionFace({ name: "data-tools", state: "input", mtime: now - 9 * min }),
);
write(
	"session-idle",
	sessionFace({ name: "docs-site", state: "idle", mtime: now - 3 * 60 * min }),
);

write("approve", approveFace({ name: "webapp" }));
write("deny", denyFace({ name: "webapp" }));

write(
	"sessions",
	sessionsListFace(
		[
			{ name: "webapp", state: "needs-ok" },
			{ name: "api-server", state: "running" },
			{ name: "data-tools", state: "input" },
			{ name: "docs-site", state: "idle" },
			{ name: "infra", state: "idle" },
		],
		{ offset: 0, slotCount: 3, page: 0, pages: 2, active: 3, today: 5 },
	),
);

write(
	"usage",
	statFace({ label: "TODAY", value: "$28.61", valueSize: 40, sub: "13.6M tok" }),
);

write(
	"limits",
	limitsFace(
		[
			{ label: "5 HR", percent: 49, resetsAt: now + 90 * min, active: true },
			{ label: "WEEK", percent: 22, resetsAt: null, active: false },
			{ label: "OPUS", percent: 67, resetsAt: null, active: false },
		],
		false,
	),
);

console.log("done");

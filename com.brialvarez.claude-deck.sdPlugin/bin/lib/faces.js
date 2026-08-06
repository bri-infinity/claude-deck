// Key face rendering: pure functions from data to SVG data URIs (144x144).
// No module here reads app state — callers pass everything in.

const FG = "#f4f2ee";
const DIM = "#7f7f92";
const ACCENT = "#d97757";
const GREEN = "#34d399";
const AMBER = "#fbbf24";
const BLUE = "#60a5fa";
const RED = "#f87171";
const GRAY = "#4b4b58";
const FONTS = `-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

export const SESSION_STATES = {
	running: { color: GREEN, label: "RUNNING" },
	"needs-ok": { color: AMBER, label: "NEEDS OK" },
	input: { color: BLUE, label: "INPUT?" },
	idle: { color: GRAY, label: "IDLE" },
};

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

export function ago(mtime) {
	const s = Math.max(0, (Date.now() - mtime) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

export function fmtCost(cost) {
	if (cost >= 100) return `$${Math.round(cost)}`;
	return `$${cost.toFixed(2)}`;
}

export function fmtTokens(tokens) {
	if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B tok`;
	if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M tok`;
	if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k tok`;
	return `${tokens} tok`;
}

/** Generic stat face: label / big value / sub-line. `dot` is a CSS color. */
export function statFace({ label, value, sub, dot, valueColor = FG, valueSize = 44 }) {
	return svgWrap(
		`<rect x="0" y="0" width="144" height="4" rx="2" fill="${ACCENT}" opacity="0.85"/>` +
			(dot ? glowDot(120, 28, dot) : "") +
			`<text x="16" y="34" font-family="${FONTS}" font-size="14" font-weight="600" letter-spacing="2" fill="${DIM}">${esc(label)}</text>` +
			`<text x="72" y="90" text-anchor="middle" font-family="${FONTS}" font-size="${valueSize}" font-weight="700" fill="${valueColor}">${esc(value)}</text>` +
			`<text x="72" y="124" text-anchor="middle" font-family="${FONTS}" font-size="16" fill="${DIM}">${esc(sub)}</text>`,
	);
}

/** Face for one Session slot key; `session` may be null (empty slot). */
export function sessionFace(session) {
	if (!session) {
		return svgWrap(
			`<text x="72" y="82" text-anchor="middle" font-family="${FONTS}" font-size="34" fill="#33333e">·</text>`,
		);
	}
	const st = SESSION_STATES[session.state];
	const name = truncate(session.name, 14);
	const size = fitFont(name, 26);
	const attention =
		session.state === "needs-ok" || session.state === "input"
			? `<rect x="0" y="0" width="144" height="144" rx="20" fill="none" stroke="${st.color}" stroke-width="3" opacity="0.65"/>`
			: "";
	return svgWrap(
		`<rect x="0" y="0" width="144" height="5" rx="2.5" fill="${st.color}"/>` +
			attention +
			glowDot(120, 28, st.color) +
			`<text x="16" y="34" font-family="${FONTS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${st.color}">${esc(st.label)}</text>` +
			`<text x="72" y="86" text-anchor="middle" font-family="${FONTS}" font-size="${size}" font-weight="700" fill="${FG}">${esc(name)}</text>` +
			`<text x="72" y="122" text-anchor="middle" font-family="${FONTS}" font-size="15" fill="${DIM}">${esc(ago(session.mtime))}</text>`,
	);
}

/** Approve / Deny faces; `target` is the session that would be acted on. */
export function approveFace(target) {
	const active = Boolean(target);
	const color = active ? GREEN : "#2e4038";
	return svgWrap(
		`<path d="M44 74 L64 94 L102 52" fill="none" stroke="${color}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
			`<text x="72" y="126" text-anchor="middle" font-family="${FONTS}" font-size="16" font-weight="600" fill="${active ? FG : DIM}">${esc(active ? truncate(target.name, 13) : "—")}</text>`,
	);
}

export function denyFace(target) {
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
 * view: { offset, slotCount, page, pages, active, today }
 */
export function sessionsListFace(sessions, view) {
	const { offset, slotCount, page, pages, active, today } = view;
	const header = pages > 1 ? `SESSIONS ${page + 1}/${pages}` : "SESSIONS";
	let inner =
		`<rect x="0" y="0" width="144" height="4" rx="2" fill="${ACCENT}" opacity="0.85"/>` +
		`<text x="14" y="26" font-family="${FONTS}" font-size="13" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc(header)}</text>`;
	// scroll the 4-row window so the current page's sessions are visible
	const start = Math.min(offset, Math.max(0, sessions.length - 4));
	const shown = sessions.slice(start, start + 4);
	shown.forEach((s, i) => {
		const y = 46 + i * 20;
		const st = SESSION_STATES[s.state];
		const abs = start + i;
		const onDeck = abs >= offset && abs < offset + Math.max(1, slotCount);
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

/** Plan-limit bars; `rows` may be null (no data yet), `stale` dims trust. */
export function limitsFace(rows, stale) {
	if (!rows) {
		return svgWrap(
			`<text x="72" y="60" text-anchor="middle" font-family="${FONTS}" font-size="16" font-weight="600" letter-spacing="2" fill="${DIM}">LIMITS</text>` +
				`<text x="72" y="92" text-anchor="middle" font-family="${FONTS}" font-size="15" fill="${GRAY}">no data yet</text>`,
		);
	}
	let inner = stale ? `<circle cx="128" cy="16" r="4" fill="${AMBER}" opacity="0.8"/>` : "";
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

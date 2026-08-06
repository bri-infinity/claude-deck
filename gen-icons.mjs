// Generates the plugin's PNG icons without any image libraries.
// SDF-based rendering: smooth anti-aliased shapes, gradients, soft glows.
// Run: .tools/node/bin/node gen-icons.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(
	import.meta.dirname,
	"com.brialvarez.claude-deck.sdPlugin",
	"imgs",
);

// --- minimal PNG encoder (8-bit RGBA) --------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** pixelFn(x, y) -> [r, g, b, a(0..1)]; 2x2 supersampled */
function png(size, pixelFn) {
	const raw = Buffer.alloc(size * (size * 4 + 1));
	let p = 0;
	for (let y = 0; y < size; y++) {
		raw[p++] = 0;
		for (let x = 0; x < size; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
				const [pr, pg, pb, pa] = pixelFn(x + dx, y + dy);
				r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
			}
			a /= 4;
			raw[p++] = a > 0 ? Math.min(255, Math.round(r / 4 / a)) : 0;
			raw[p++] = a > 0 ? Math.min(255, Math.round(g / 4 / a)) : 0;
			raw[p++] = a > 0 ? Math.min(255, Math.round(b / 4 / a)) : 0;
			raw[p++] = Math.round(Math.min(1, a) * 255);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// --- SDF helpers -----------------------------------------------------------
// All sdf* return signed distance in px (negative = inside).

function sdCircle(x, y, cx, cy, r) {
	return Math.hypot(x - cx, y - cy) - r;
}

/** capsule: line segment with round caps */
function sdCapsule(x, y, x1, y1, x2, y2, r) {
	const dx = x2 - x1, dy = y2 - y1;
	const px = x - x1, py = y - y1;
	const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
	return Math.hypot(px - dx * h, py - dy * h) - r;
}

function sdRoundedRect(x, y, cx, cy, hw, hh, r) {
	const qx = Math.abs(x - cx) - hw + r;
	const qy = Math.abs(y - cy) - hh + r;
	const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** distance -> coverage alpha with 1px anti-aliasing */
const aa = (d) => Math.max(0, Math.min(1, 0.5 - d));

const lerp = (a, b, t) => a + (b - a) * t;

/** blend src [r,g,b,a] over dst [r,g,b,a] */
function over(dst, src) {
	const a = src[3] + dst[3] * (1 - src[3]);
	if (a === 0) return [0, 0, 0, 0];
	return [
		(src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
		(src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
		(src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
		a,
	];
}

// --- palette ---------------------------------------------------------------

const ACCENT = [0xd9, 0x77, 0x57];
const ACCENT_HI = [0xe8, 0x9a, 0x7a];
const LIGHT = [0xf4, 0xf2, 0xee];
const BG_TOP = [0x1d, 0x1d, 0x29];
const BG_BOT = [0x0f, 0x0f, 0x16];

/** 6-armed spark: capsules at 90/30/-30 degrees */
function sparkDist(x, y, cx, cy, radius, thickness) {
	let d = Infinity;
	for (const deg of [90, 30, -30]) {
		const a = (deg * Math.PI) / 180;
		const ux = Math.cos(a) * radius, uy = Math.sin(a) * radius;
		d = Math.min(d, sdCapsule(x, y, cx - ux, cy - uy, cx + ux, cy + uy, thickness));
	}
	return d;
}

function write(rel, buf) {
	const file = path.join(OUT, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, buf);
	console.log(`wrote ${rel} (${buf.length} bytes)`);
}

// --- icons -----------------------------------------------------------------

// Plugin icon: gradient rounded square, terracotta spark with soft glow
function pluginIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const card = sdRoundedRect(x, y, s / 2, s / 2, s * 0.47, s * 0.47, s * 0.17);
		if (card > 0.5) return [0, 0, 0, 0];
		const t = y / s;
		let px = [lerp(BG_TOP[0], BG_BOT[0], t), lerp(BG_TOP[1], BG_BOT[1], t), lerp(BG_TOP[2], BG_BOT[2], t), aa(card)];
		const spark = sparkDist(x, y, s / 2, s / 2, s * 0.26, s * 0.05);
		// soft glow
		const glow = Math.max(0, 1 - spark / (s * 0.14)) * 0.35;
		if (glow > 0) px = over(px, [...ACCENT, glow]);
		// gradient on the spark itself (lighter on top)
		const sparkCol = [
			lerp(ACCENT_HI[0], ACCENT[0], t),
			lerp(ACCENT_HI[1], ACCENT[1], t),
			lerp(ACCENT_HI[2], ACCENT[2], t),
		];
		px = over(px, [...sparkCol, aa(spark)]);
		return px;
	});
}

// Category icon: light spark, transparent bg
function categoryIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const d = sparkDist(x, y, s / 2, s / 2, s * 0.38, s * 0.085);
		return [...LIGHT, aa(d)];
	});
}

// Session action icon: terminal prompt — chevron + underscore
function sessionIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const w = s * 0.1;
		const d = Math.min(
			sdCapsule(x, y, s * 0.16, s * 0.24, s * 0.44, s * 0.5, w),
			sdCapsule(x, y, s * 0.44, s * 0.5, s * 0.16, s * 0.76, w),
			sdCapsule(x, y, s * 0.56, s * 0.76, s * 0.86, s * 0.76, w),
		);
		return [...LIGHT, aa(d)];
	});
}

// Approve action icon: check mark
function approveIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const w = s * 0.11;
		const d = Math.min(
			sdCapsule(x, y, s * 0.2, s * 0.55, s * 0.42, s * 0.76, w),
			sdCapsule(x, y, s * 0.42, s * 0.76, s * 0.82, s * 0.28, w),
		);
		return [...LIGHT, aa(d)];
	});
}

// Deny action icon: X
function denyIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const w = s * 0.11;
		const d = Math.min(
			sdCapsule(x, y, s * 0.26, s * 0.26, s * 0.74, s * 0.74, w),
			sdCapsule(x, y, s * 0.74, s * 0.26, s * 0.26, s * 0.74, w),
		);
		return [...LIGHT, aa(d)];
	});
}

// Sessions action icon: two overlapping session dots
function sessionsIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const d = Math.min(
			sdCircle(x, y, s * 0.36, s * 0.4, s * 0.24),
			sdCircle(x, y, s * 0.64, s * 0.62, s * 0.24),
		);
		return [...LIGHT, aa(d)];
	});
}

// Usage action icon: three ascending rounded bars
function usageIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const w = s * 0.09;
		const d = Math.min(
			sdCapsule(x, y, s * 0.24, s * 0.62, s * 0.24, s * 0.82, w),
			sdCapsule(x, y, s * 0.5, s * 0.42, s * 0.5, s * 0.82, w),
			sdCapsule(x, y, s * 0.76, s * 0.2, s * 0.76, s * 0.82, w),
		);
		return [...LIGHT, aa(d)];
	});
}

// Limits action icon: gauge — half-ring + needle
function limitsIcon(size) {
	const s = size;
	return png(s, (x, y) => {
		const cx = s / 2, cy = s * 0.62;
		const rOut = s * 0.4, rIn = s * 0.26;
		const dc = Math.hypot(x - cx, y - cy);
		// half annulus (upper half)
		let d = Math.max(Math.max(rIn - dc, dc - rOut), y - cy);
		// needle pointing up-right
		const needle = sdCapsule(x, y, cx, cy, cx + s * 0.22, cy - s * 0.26, s * 0.055);
		d = Math.min(d, needle);
		// hub
		d = Math.min(d, sdCircle(x, y, cx, cy, s * 0.09));
		return [...LIGHT, aa(d)];
	});
}

// Default key background: gradient card + faint spark
function keyImage(size) {
	const s = size;
	return png(s, (x, y) => {
		const card = sdRoundedRect(x, y, s / 2, s / 2, s / 2, s / 2, s * 0.14);
		if (card > 0.5) return [0, 0, 0, 0];
		const t = y / s;
		let px = [lerp(BG_TOP[0], BG_BOT[0], t), lerp(BG_TOP[1], BG_BOT[1], t), lerp(BG_TOP[2], BG_BOT[2], t), aa(card)];
		const spark = sparkDist(x, y, s / 2, s / 2, s * 0.2, s * 0.035);
		px = over(px, [...ACCENT, aa(spark) * 0.5]);
		return px;
	});
}

write("plugin/icon.png", pluginIcon(256));
write("plugin/icon@2x.png", pluginIcon(512));
write("plugin/category-icon.png", categoryIcon(28));
write("plugin/category-icon@2x.png", categoryIcon(56));
write("actions/session.png", sessionIcon(20));
write("actions/session@2x.png", sessionIcon(40));
write("actions/approve.png", approveIcon(20));
write("actions/approve@2x.png", approveIcon(40));
write("actions/deny.png", denyIcon(20));
write("actions/deny@2x.png", denyIcon(40));
write("actions/sessions.png", sessionsIcon(20));
write("actions/sessions@2x.png", sessionsIcon(40));
write("actions/usage.png", usageIcon(20));
write("actions/usage@2x.png", usageIcon(40));
write("actions/limits.png", limitsIcon(20));
write("actions/limits@2x.png", limitsIcon(40));
write("actions/key.png", keyImage(72));
write("actions/key@2x.png", keyImage(144));
console.log("done");

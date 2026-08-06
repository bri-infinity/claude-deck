// Plan limits — the same numbers `/usage` shows, from the OAuth usage
// endpoint, authenticated with the user's existing Claude Code token
// (read-only; the refresh token is never touched).
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import { run } from "./exec.js";
import { log } from "./log.js";

const TOKEN_CACHE_MS = 10 * 60_000;
const BASE_INTERVAL_MS = 2 * 60_000; // polite polling floor
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

class ClaudeLimits {
	rows = null; // [{ label, percent, resetsAt, active }]
	fetchedAt = 0;
	#token = null;
	#tokenAt = 0;
	#nextAttempt = 0;
	#backoffLogged = false;

	async #getToken() {
		if (this.#token && Date.now() - this.#tokenAt < TOKEN_CACHE_MS) return this.#token;
		let raw = await run("security", [
			"find-generic-password",
			"-s",
			"Claude Code-credentials",
			"-w",
		]);
		if (!raw) {
			try {
				raw = fs.readFileSync(
					path.join(os.homedir(), ".claude", ".credentials.json"),
					"utf8",
				);
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
			// rate limited — keep last data, back off
			this.#nextAttempt = Date.now() + RATE_LIMIT_BACKOFF_MS;
			if (!this.#backoffLogged) {
				log("limits: 429 rate limited, backing off");
				this.#backoffLogged = true;
			}
			return;
		}
		if (!res || res.status !== 200) {
			log(`limits fetch failed: ${res?.status ?? "network"}`);
			this.#nextAttempt = Date.now() + BASE_INTERVAL_MS;
			return;
		}
		this.#backoffLogged = false;
		this.#nextAttempt = Date.now() + BASE_INTERVAL_MS;
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

export const limits = new ClaudeLimits();

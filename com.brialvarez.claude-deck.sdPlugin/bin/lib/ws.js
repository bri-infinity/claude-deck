// Minimal WebSocket client (RFC 6455, client side) for the Stream Deck app's
// local ws:// server. Supports text, ping/pong, and close frames.
//
// Known limitation: continuation frames (fragmented messages) are ignored.
// Stream Deck sends small, unfragmented frames, so this does not occur in
// practice; revisit if payloads ever exceed a single frame.
import net from "node:net";
import crypto from "node:crypto";
import { log } from "./log.js";

export class MiniWebSocket {
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
				case 0x1: // text
					this.onmessage?.(payload.toString("utf8"));
					break;
				case 0x8: // close: echo and shut down
					this.#sendFrame(0x8, payload);
					this.#socket.end();
					return;
				case 0x9: // ping -> pong
					this.#sendFrame(0xa, payload);
					break;
				default: // pong / continuation / binary: ignored
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

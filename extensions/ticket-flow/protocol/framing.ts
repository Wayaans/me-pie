import { ProtocolMessageError, decodeProtocolMessage, type ProtocolEnvelope } from "./messages.ts";

export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
export const MAX_PROTOCOL_BUFFER_BYTES = 128 * 1024;
export class ProtocolFrameError extends Error { constructor(message: string) { super(message); this.name = "ProtocolFrameError"; } }
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeJsonLine(message: ProtocolEnvelope): Buffer {
	const text = JSON.stringify(message);
	const bytes = Buffer.from(`${text}\n`, "utf8");
	if (bytes.length > MAX_PROTOCOL_LINE_BYTES) throw new ProtocolFrameError("Protocol frame exceeds the maximum size");
	return bytes;
}

export class JsonLineFramer {
	private buffer = Buffer.alloc(0);
	push(chunk: Buffer | Uint8Array): ProtocolEnvelope[] {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		if (this.buffer.length > MAX_PROTOCOL_BUFFER_BYTES) throw new ProtocolFrameError("Protocol receive buffer exceeds the maximum size");
		const messages: ProtocolEnvelope[] = [];
		for (;;) {
			const index = this.buffer.indexOf(0x0a);
			if (index < 0) break;
			if (index > MAX_PROTOCOL_LINE_BYTES) throw new ProtocolFrameError("Protocol frame exceeds the maximum size");
			let frame = this.buffer.subarray(0, index);
			this.buffer = this.buffer.subarray(index + 1);
			if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
			if (frame.length === 0) throw new ProtocolFrameError("Protocol frame must not be empty");
			try {
				messages.push(decodeProtocolMessage(JSON.parse(decoder.decode(frame))));
			} catch (cause) {
				if (cause instanceof ProtocolMessageError) throw cause;
				throw new ProtocolFrameError(`Invalid UTF-8 JSONL protocol frame: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
		if (this.buffer.length > MAX_PROTOCOL_LINE_BYTES) throw new ProtocolFrameError("Protocol frame exceeds the maximum size");
		return messages;
	}
}

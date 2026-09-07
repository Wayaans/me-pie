import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { Effect } from "effect";
import { BRIDGE_VERSION, configurationFingerprint, parseBridgeRequest, readFrames, sendFrame } from "./bridge-protocol.ts";
import { TelegramBridgeEngine } from "./bridge-engine.ts";
import type { TelegramCall, TelegramConfig } from "./telegram.ts";

/** Owns the socket, poller and all client resources. No resources start on import. */
export async function runBridgeServer(path: string, config: TelegramConfig, call: TelegramCall, signal: AbortSignal, idleMs = 15_000): Promise<void> {
	const stop = new AbortController();
	const combined = AbortSignal.any([signal, stop.signal]);
	const sockets = new Set<Socket>();
	const engine = new TelegramBridgeEngine(config, call);
	let ready = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const scheduleIdle = () => {
		if (idle) clearTimeout(idle);
		if (!combined.aborted) idle = setTimeout(() => stop.abort(), idleMs);
	};
	const server = createServer((socket) => {
		if (combined.aborted || sockets.size >= 64) { socket.destroy(); return; }
		if (idle) clearTimeout(idle);
		sockets.add(socket);
		const client = engine.connect((response) => {
			try { sendFrame(socket, response); } catch { socket.destroy(); }
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			client.close(); sockets.delete(socket);
			if (sockets.size === 0) scheduleIdle();
		});
		readFrames(socket, (value) => { if (!ready) { socket.destroy(); return; } client.receive(parseBridgeRequest(value)); });
		if (ready) sendFrame(socket, { type: "ready", version: BRIDGE_VERSION, configuration: configurationFingerprint(config) });
	});
	const acquire = Effect.tryPromise({
		try: async () => {
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(path, () => { server.removeListener("error", reject); resolve(); });
				});
				await chmod(path, 0o600);
			} catch {
				stop.abort();
				engine.close();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				throw new Error("ask_me bridge socket setup failed");
			}
			server.on("error", () => stop.abort());
			scheduleIdle();
			return server;
		},
		catch: () => new Error("ask_me bridge could not bind its private socket"),
	});
	const release = Effect.promise(async () => {
		stop.abort();
		if (idle) clearTimeout(idle);
		engine.close();
		await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => {
			const deadline = setTimeout(() => { socket.destroy(); resolve(); }, 100);
			socket.end(() => { clearTimeout(deadline); socket.destroy(); resolve(); });
		})));
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await Effect.runPromise(Effect.acquireUseRelease(acquire,
		() => Effect.tryPromise({ try: async () => {
			try {
				await engine.poll(combined, () => {
					ready = true;
					for (const socket of sockets) sendFrame(socket, { type: "ready", version: BRIDGE_VERSION, configuration: configurationFingerprint(config) });
				});
			} catch (error) {
				for (const socket of sockets) sendFrame(socket, { type: "error", message: error instanceof Error ? error.message : "ask_me bridge poller stopped" });
				throw error;
			}
		}, catch: () => new Error("ask_me bridge poller stopped") }),
		() => release,
	));
}

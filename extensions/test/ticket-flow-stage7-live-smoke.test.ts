import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { ProtocolServer } from "../ticket-flow/protocol/server.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) { if (Date.now() > deadline) throw new Error("Live recovery smoke timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("bounded live native-socket smoke reconnects after listener recreation", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage7-live-"));
	const socketPath = path.join(directory, "workflow.sock");
	const options = { socketPath, runId: "live-recovery", workItemId: "one", token: "owner-token", profile };
	let server = new ProtocolServer(options);
	await Effect.runPromise(server.start());
	const client = new ProtocolClient({
		socketPath,
		identity: { runId: "live-recovery", workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", sessionId: "worker-session" },
		token: "owner-token",
		onDelegate: () => undefined,
		onFeedback: () => undefined,
		onShutdown: () => undefined,
		retryDelaysMs: [10],
	});
	await Effect.runPromise(client.start()); await eventually(() => server.isVerified && client.isVerified);
	await Effect.runPromise(server.shutdown());
	server = new ProtocolServer(options); await Effect.runPromise(server.start());
	await eventually(() => server.isVerified && client.isVerified);
	assert.equal(client.isStopped, false);
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown());
	fs.rmSync(directory, { recursive: true, force: true });
});

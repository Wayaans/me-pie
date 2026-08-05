import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import type { WorkflowProtocolEvent } from "../ticket-flow/protocol/messages.ts";
import { ProtocolServer } from "../ticket-flow/protocol/server.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
const worker = { runId: "reliability-run", workItemId: "item", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" as const };
const report = { report: { status: "completed" as const, summary: "done" } };

function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) { resolve(); return; }
			if (Date.now() >= deadline) { reject(new Error("Timed out waiting for protocol condition")); return; }
			setTimeout(check, 5);
		};
		check();
	});
}
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
function socketPath(): { readonly directory: string; readonly path: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-protocol-reliability-"));
	return { directory, path: path.join(directory, "worker.sock") };
}
function serverPeer(server: ProtocolServer): import("node:net").Socket {
	const peer = (server as unknown as { readonly peer?: import("node:net").Socket }).peer;
	if (!peer) throw new Error("Protocol server has no connected peer");
	return peer;
}
function pendingSubmissions(client: ProtocolClient): Map<string, unknown> {
	return (client as unknown as { readonly pendingSubmissions: Map<string, unknown> }).pendingSubmissions;
}

interface Harness {
	readonly directory: string;
	readonly server: ProtocolServer;
	readonly client: ProtocolClient;
}
async function startHarness(onEvent: (event: WorkflowProtocolEvent) => Promise<void> | void): Promise<Harness> {
	const temporary = socketPath();
	const server = new ProtocolServer({ socketPath: temporary.path, runId: worker.runId, workItemId: worker.workItemId, token: "secret", profile, onEvent });
	await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath: temporary.path, identity: worker, token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [1, 2, 5] });
	await Effect.runPromise(client.start());
	await eventually(() => server.isVerified && client.isVerified);
	return { directory: temporary.directory, server, client };
}
async function stopHarness(harness: Harness): Promise<void> {
	await Effect.runPromise(harness.client.shutdown());
	await Effect.runPromise(harness.server.shutdown());
	fs.rmSync(harness.directory, { recursive: true, force: true });
}

test("reliable submissions survive disconnect before acknowledgement and resend once", async () => {
	let calls = 0;
	const messageIds: string[] = [];
	const entered = deferred();
	const release = deferred();
	const harness = await startHarness(async (event) => {
		if (event.type !== "worker-report") return;
		calls += 1;
		messageIds.push(event.messageId);
		if (calls === 1) { entered.resolve(); await release.promise; }
	});
	try {
		const submission = harness.client.submitWorkerEvent("worker-report", report);
		await entered.promise;
		serverPeer(harness.server).destroy();
		release.resolve();
		const messageId = await submission;
		assert.equal(messageIds[0], messageId);
		assert.deepEqual(messageIds, [messageId]);
		assert.equal(calls, 1);
	} finally {
		release.resolve();
		await stopHarness(harness);
	}
});

test("a persistence failure leaves the same envelope pending for reconnect retry", async () => {
	let calls = 0;
	const messageIds: string[] = [];
	const harness = await startHarness(async (event) => {
		if (event.type !== "worker-report") return;
		calls += 1;
		messageIds.push(event.messageId);
		if (calls === 1) throw new Error("transient persistence failure");
	});
	try {
		const messageId = await harness.client.submitWorkerEvent("worker-report", report);
		await eventually(() => calls === 2);
		assert.deepEqual(messageIds, [messageId, messageId]);
	} finally {
		await stopHarness(harness);
	}
});

test("duplicate worker envelopes with the same bytes execute once", async () => {
	let calls = 0;
	const harness = await startHarness((event) => { if (event.type === "worker-progress") calls += 1; });
	try {
		const messageId = harness.client.sendWorkerEvent("worker-progress", { report: { status: "progress", summary: "working" } }, "same-event-id");
		await harness.server.wait((event) => event.type === "worker-progress");
		await eventually(() => !pendingSubmissions(harness.client).has(messageId));
		harness.client.sendWorkerEvent("worker-progress", { report: { status: "progress", summary: "working" } }, messageId);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls, 1);
	} finally {
		await stopHarness(harness);
	}
});

test("conflicting duplicate worker IDs reject the authenticated peer", async () => {
	let calls = 0;
	const harness = await startHarness((event) => { if (event.type === "worker-progress") calls += 1; });
	try {
		const messageId = harness.client.sendWorkerEvent("worker-progress", { report: { status: "progress", summary: "working" } }, "conflicting-event-id");
		await harness.server.wait((event) => event.type === "worker-progress");
		await eventually(() => !pendingSubmissions(harness.client).has(messageId));
		harness.client.sendWorkerEvent("worker-progress", { report: { status: "progress", summary: "different" } }, messageId);
		await eventually(() => harness.client.isStopped);
		assert.equal(calls, 1);
	} finally {
		await stopHarness(harness);
	}
});

test("aborting while disconnected removes the submission and prevents resend", async () => {
	let calls = 0;
	const entered = deferred();
	const release = deferred();
	const harness = await startHarness(async (event) => {
		if (event.type !== "worker-report") return;
		calls += 1;
		entered.resolve();
		await release.promise;
	});
	try {
		const abort = new AbortController();
		const submission = harness.client.submitWorkerEvent("worker-report", report, abort.signal);
		await entered.promise;
		serverPeer(harness.server).destroy();
		abort.abort(new Error("aborted while disconnected"));
		release.resolve();
		await assert.rejects(submission, /aborted while disconnected/);
		await eventually(() => harness.client.isVerified);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls, 1);
		assert.equal(pendingSubmissions(harness.client).size, 0);
	} finally {
		release.resolve();
		await stopHarness(harness);
	}
});

test("shutdown rejects and clears all pending submissions", async () => {
	const entered = deferred();
	const release = deferred();
	const harness = await startHarness(async (event) => {
		if (event.type === "worker-report") { entered.resolve(); await release.promise; }
	});
	try {
		const submission = harness.client.submitWorkerEvent("worker-report", report);
		await entered.promise;
		await Effect.runPromise(harness.client.shutdown());
		await assert.rejects(submission, /protocol client closed/);
		assert.equal(pendingSubmissions(harness.client).size, 0);
		release.resolve();
	} finally {
		release.resolve();
		await Effect.runPromise(harness.server.shutdown());
		fs.rmSync(harness.directory, { recursive: true, force: true });
	}
});

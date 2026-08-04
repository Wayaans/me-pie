import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { JsonLineFramer, MAX_PROTOCOL_LINE_BYTES } from "../ticket-flow/protocol/framing.ts";
import { makeMessage, type ProtocolEnvelope } from "../ticket-flow/protocol/messages.ts";
import { ProtocolServer } from "../ticket-flow/protocol/server.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { WorkflowPlan, WorkItem } from "../ticket-flow/domain.ts";
import { readWorkflowToken, removeWorkflowToken, workflowSocketPath, writeWorkflowToken, workflowTokenPath } from "../ticket-flow/protocol/runtime.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
function temporarySocket(name: string): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage4-")); return path.join(directory, `${name}.sock`); }
function identity(overrides: Partial<{ runId: string; workItemId: string; provider: string; model: string; thinking: "high" }> = {}) { return { runId: "run-stage4", workItemId: "item", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" as const, ...overrides }; }
function connected(overrides: Record<string, unknown> = {}): ProtocolEnvelope { const worker = identity(); return makeMessage(worker.runId, worker.workItemId, "worker-connected", { token: "secret", provider: worker.provider, model: worker.model, thinking: worker.thinking, ...overrides }); }
async function rawSocket(socketPath: string): Promise<net.Socket> { return new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); socket.once("connect", () => resolve(socket)); socket.once("error", reject); }); }
async function eventually(predicate: () => boolean, ms = 1_000): Promise<void> { const until = Date.now() + ms; while (!predicate()) { if (Date.now() >= until) throw new Error("Timed out waiting for condition"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("strict JSONL framing handles fragmented, multiple, and CRLF frames", () => {
	const first = makeMessage("run", "item", "ping", {});
	const second = makeMessage("run", "item", "accepted", { requestId: "request" });
	const framer = new JsonLineFramer();
	const frames = Buffer.concat([Buffer.from(JSON.stringify(first)), Buffer.from("\r\n"), Buffer.from(JSON.stringify(second)), Buffer.from("\n")]);
	assert.deepEqual(framer.push(frames.subarray(0, 7)), []);
	assert.deepEqual(framer.push(frames.subarray(7)).map((message) => message.type), ["ping", "accepted"]);
	assert.throws(() => new JsonLineFramer().push(Buffer.from("not json\n")), /Invalid UTF-8 JSONL/);
	assert.throws(() => new JsonLineFramer().push(Buffer.concat([Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1), Buffer.from("\n")])), /maximum size/);
});

test("server rejects version, token, run, item, model, and thinking mismatches", async () => {
	for (const [name, message] of Object.entries({
		version: { ...connected(), version: 2 }, token: connected({ token: "wrong" }), run: { ...connected(), runId: "wrong" }, item: { ...connected(), workItemId: "wrong" }, model: connected({ model: "other" }), thinking: connected({ thinking: "medium" }),
	})) {
		const socketPath = temporarySocket(name);
		const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile });
		await Effect.runPromise(server.start());
		const socket = await rawSocket(socketPath);
		socket.write(Buffer.from(`${JSON.stringify(message)}\n`));
		await new Promise<void>((resolve) => socket.once("close", resolve));
		assert.equal(server.isVerified, false, name);
		await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
	}
});

test("successful authenticated handshake rejects duplicate peers and permits native delegation", async () => {
	const socketPath = temporarySocket("handshake"); const events: string[] = []; const prompts: string[] = [];
	const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile, onEvent: (event) => { events.push(event.type); } });
	await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath, identity: identity(), token: "secret", onDelegate: (prompt) => { prompts.push(prompt); }, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start()); await eventually(() => server.isVerified && client.isVerified);
	const duplicate = await rawSocket(socketPath); await new Promise<void>((resolve) => duplicate.once("close", resolve));
	server.send("delegate", { prompt: "/implement only this", requestId: "delegate-1" }, "delivery-1"); await eventually(() => prompts.length === 1);
	server.send("delegate", { prompt: "/implement only this", requestId: "delegate-1" }, "delivery-1"); await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(prompts.length, 1, "duplicate delivery with the same message ID is idempotent");
	await eventually(() => events.includes("worker-ready"));
	assert.equal(events[0], "worker-connected");
	assert.ok(events.includes("worker-ready"));
	server.send("delegate", { prompt: "/different second ticket", requestId: "delegate-2" }, "delivery-2");
	await eventually(() => !client.isVerified);
	assert.equal(prompts.length, 1, "a conflicting second delegation is rejected");
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("clients stop retrying after every explicit identity rejection", async () => {
	for (const [name, options] of Object.entries({
		token: { identity: identity(), token: "wrong" }, run: { identity: identity({ runId: "wrong" }), token: "secret" }, item: { identity: identity({ workItemId: "wrong" }), token: "secret" }, model: { identity: identity({ model: "wrong" }), token: "secret" }, thinking: { identity: { ...identity(), thinking: "medium" as "high" }, token: "secret" },
	})) {
		const socketPath = temporarySocket(`reject-${name}`); const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile }); await Effect.runPromise(server.start());
		const client = new ProtocolClient({ socketPath, identity: options.identity, token: options.token, onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [5] }); await Effect.runPromise(client.start()); await eventually(() => client.isStopped);
		await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(client.isStopped, true, name); await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
	}
});

test("server rejects messages before verification and client reconnects after server restart", async () => {
	const socketPath = temporarySocket("reconnect");
	const create = () => new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile });
	let server = create(); await Effect.runPromise(server.start());
	const unauthenticated = await rawSocket(socketPath); unauthenticated.write(Buffer.from(`${JSON.stringify(makeMessage("run-stage4", "item", "worker-ready", {}))}\n`)); await new Promise<void>((resolve) => unauthenticated.once("close", resolve));
	const client = new ProtocolClient({ socketPath, identity: identity(), token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10, 10] });
	await Effect.runPromise(client.start()); await eventually(() => server.isVerified);
	await Effect.runPromise(server.shutdown()); server = create(); await Effect.runPromise(server.start()); await eventually(() => server.isVerified);
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("invalid UTF-8 and malformed full worker report payloads close the peer", async () => {
	const socketPath = temporarySocket("malformed");
	const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile });
	await Effect.runPromise(server.start());
	const invalid = await rawSocket(socketPath); invalid.write(Buffer.from([0xff, 0x0a])); await new Promise<void>((resolve) => invalid.once("close", resolve));
	const worker = await rawSocket(socketPath); worker.write(Buffer.from(`${JSON.stringify(connected())}\n`)); await eventually(() => server.isVerified);
	worker.write(Buffer.from(`${JSON.stringify(makeMessage("run-stage4", "item", "worker-report", { report: { status: "completed", summary: "done", checks: "not-an-array" } }))}\n`));
	await new Promise<void>((resolve) => worker.once("close", resolve));
	await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("waits consume events once, cancellation and timeout dispose only their waits", async () => {
	const socketPath = temporarySocket("waits"); const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile }); await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath, identity: identity(), token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] }); await Effect.runPromise(client.start()); await eventually(() => server.isVerified);
	assert.equal((await server.wait()).type, "worker-connected"); assert.equal((await server.wait()).type, "worker-ready");
	const abort = new AbortController(); const cancelled = server.wait(() => false, abort.signal); abort.abort(); await assert.rejects(cancelled, /Abort/);
	const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(new Error("timeout")), 10); await assert.rejects(server.wait(() => false, timeout.signal), /timeout/); clearTimeout(timer);
	assert.equal(server.isVerified, true);
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("command acknowledgements, duplicate worker events, and worker shutdown are idempotent", async () => {
	const socketPath = temporarySocket("ack"); const received: string[] = []; const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile }); await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath, identity: identity(), token: "secret", onDelegate: () => undefined, onFeedback: (message) => { received.push(message); }, onShutdown: () => undefined, retryDelaysMs: [10] }); await Effect.runPromise(client.start()); await eventually(() => server.isVerified);
	const first = server.send("feedback", { message: "first", requestId: "feedback-1" }, "feedback-message")!; await server.waitForAcknowledgement(first.requestId); assert.deepEqual(received, ["first"]);
	const duplicate = server.send("feedback", { message: "first", requestId: "feedback-1" }, "another-id")!; assert.deepEqual(duplicate, first); await server.waitForAcknowledgement(duplicate.requestId); await new Promise((resolve) => setTimeout(resolve, 10)); assert.deepEqual(received, ["first"]);
	const exit = server.wait((event) => event.type === "worker-shutdown"); await Effect.runPromise(client.shutdown()); assert.equal((await exit).type, "worker-shutdown");
	await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("client validates and sends structured worker events", async () => {
	const socketPath = temporarySocket("client-events"); const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile }); await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath, identity: identity(), token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined }); await Effect.runPromise(client.start()); await eventually(() => client.isVerified);
	const progress = server.wait((event) => event.type === "worker-progress"); client.sendWorkerEvent("worker-progress", { report: { status: "progress", summary: "working", filesChanged: [] } }); assert.equal((await progress).type, "worker-progress");
	assert.throws(() => client.sendWorkerEvent("worker-report", { report: { status: "progress", summary: "wrong status" } }), /must be completed/);
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("duplicate worker event message IDs are idempotent and conflicting IDs close the peer", async () => {
	const socketPath = temporarySocket("worker-duplicates"); const events: string[] = []; const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile, onEvent: (event) => { events.push(event.type); } }); await Effect.runPromise(server.start());
	const socket = await rawSocket(socketPath); socket.write(Buffer.from(`${JSON.stringify(connected())}\n`)); await eventually(() => server.isVerified);
	const ready = makeMessage("run-stage4", "item", "worker-ready", {}, "worker-ready-id"); socket.write(Buffer.from(`${JSON.stringify(ready)}\n${JSON.stringify(ready)}\n`)); await eventually(() => events.filter((event) => event === "worker-ready").length === 1);
	const conflicting = { ...ready, payload: { unexpected: true } }; socket.write(Buffer.from(`${JSON.stringify(conflicting)}\n`)); await new Promise<void>((resolve) => socket.once("close", resolve));
	assert.equal(events.filter((event) => event === "worker-ready").length, 1); await Effect.runPromise(server.shutdown()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("owner-only global token files are validated and cleaned idempotently", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage4-token-")); await Effect.runPromise(writeWorkflowToken(directory, "token-value"));
	const tokenFile = workflowTokenPath(directory); assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600); assert.equal(await Effect.runPromise(readWorkflowToken(directory)), "token-value");
	await Effect.runPromise(removeWorkflowToken(directory)); await Effect.runPromise(removeWorkflowToken(directory)); assert.equal(fs.existsSync(tokenFile), false); fs.rmSync(directory, { recursive: true, force: true });
});

test("protocol-start failure removes token/socket metadata and leaves no spawning worker", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage4-protocol-fail-project-")); const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage4-protocol-fail-agent-")); const runId = `fail-${crypto.randomUUID()}`;
	const socketPath = workflowSocketPath(runId); fs.mkdirSync(path.dirname(socketPath), { recursive: true }); fs.writeFileSync(socketPath, "foreign");
	let tools = ["read"]; const controller = new WorkflowController({ getActiveTools: () => tools, setActiveTools: (next) => { tools = next; } }, undefined, () => runId, {} as never);
	const item: WorkItem = { id: "item", title: "Item", sourcePaths: ["ticket"], specificationPaths: ["spec"], requirements: ["requirement"], order: 1, orderReason: "first", dependsOn: [], delegationPrompt: "/implement", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status: "planned" };
	const plan: WorkflowPlan = { summary: "plan", workItems: [item], userResolutions: [], finalized: false };
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "plan", agentDir: agent })); await Effect.runPromise(controller.savePlan(plan)); await Effect.runPromise(controller.finalizePlan());
	await assert.rejects(Effect.runPromise(controller.startWorker("item")), /stale protocol path/); assert.equal(controller.activeRun?.plan.workItems[0]?.status, "failed"); assert.equal(controller.activeRun?.workflowSocketPath, undefined);
	const runDirectory = path.join(agent, "state", "ticket-flow", controller.activeRun!.projectId, runId); assert.equal(fs.existsSync(workflowTokenPath(runDirectory)), false);
	await Effect.runPromise(controller.stop()); fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("wait cancellation only cancels the wait and cleanup removes an outside-project socket", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage4-project-")); const socketPath = workflowSocketPath(`run-${crypto.randomUUID()}`);
	assert.equal(socketPath.startsWith(project), false);
	const server = new ProtocolServer({ socketPath, runId: "run-stage4", workItemId: "item", token: "secret", profile }); await Effect.runPromise(server.start());
	const abort = new AbortController(); const waiting = server.wait(() => false, abort.signal); abort.abort(); await assert.rejects(waiting, /Abort/); assert.equal(server.isVerified, false);
	await Effect.runPromise(server.shutdown()); assert.equal(fs.existsSync(socketPath), false); fs.rmSync(project, { recursive: true, force: true });
});

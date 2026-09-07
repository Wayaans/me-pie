import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, lstat, mkdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, runOwnedBridge } from "../ask-me/bridge-runtime.ts";

test("Independent Node/jiti processes elect exactly one poller and clean up their socket", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "ask-me-election-"));
	const directory = join(temporary, "owner");
	const fixture = join(temporary, "worker.cjs");
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	await writeFile(fixture, `
		const { createRequire } = require("node:module");
		const piRequire = createRequire(${JSON.stringify(piEntry)});
		const { createJiti } = piRequire("jiti");
		const resolver = createJiti(${JSON.stringify(piEntry)});
		const { fileURLToPath } = require("node:url");
		const alias = {};
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox", "typebox/value"]) alias[name] = fileURLToPath(resolver.esmResolve(name));
		const jiti = createJiti(__filename, { alias, moduleCache: false });
		(async () => {
			const { runOwnedBridge } = await jiti.import(${JSON.stringify(resolve("extensions/ask-me/bridge-runtime.ts"))});
			const controller = new AbortController();
			const call = async (method, body, signal) => {
				if (method === "getWebhookInfo") { process.stdout.write("poller\\n"); return { url: "" }; }
				if (body.timeout === 0) return [];
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			};
			await runOwnedBridge(${JSON.stringify(directory)}, { token: "1:FAKE", botId: "1", userId: 42, chatId: 42 }, call, controller.signal, 1500);
		})().catch(() => { process.exitCode = 1; });
	`);
	try {
		const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<{ code: number | null; output: string; error: string }>((finish, reject) => {
			const child = spawn("node", [fixture], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
			let output = ""; let error = "";
			child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
			child.on("error", reject);
			child.on("close", (code) => finish({ code, output, error }));
		})));
		assert.equal(results.filter((item) => item.code === 0).length, 1, JSON.stringify(results));
		assert.equal(results.filter((item) => item.output.includes("poller")).length, 1);
		assert.ok(results.every((item) => item.error === ""));
		await assert.rejects(lstat(directory), /ENOENT/);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Bridge refuses insecure directories and never steals a crash lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ask-me-lock-"));
	const owner = join(directory, "owner");
	try {
		await mkdir(owner, { mode: 0o700 });
		let polls = 0;
		await assert.rejects(runOwnedBridge(owner, { token: "1:FAKE", botId: "1", userId: 42, chatId: 42 }, async () => { polls++; return []; }, new AbortController().signal), /already owned/);
		assert.equal(polls, 0); assert.ok((await lstat(owner)).isDirectory());
		await chmod(owner, 0o755);
		await assert.rejects(privateDirectory(owner), /0700/);
		const link = join(directory, "link"); await symlink(owner, link);
		await assert.rejects(privateDirectory(link), /symlinks/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

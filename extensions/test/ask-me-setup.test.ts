import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskMeRouting } from "../ask-me/routing.ts";
import type { remoteQuestionnaire } from "../ask-me/bridge-client.ts";
import { normalizeAskMeRequest } from "../ask-me/schema.ts";
import { MaskedTokenInput, maskedToken, runSetup, setupWizard, type SetupDependencies, type SetupUI } from "../ask-me/setup.ts";
import { readToken, writeToken, privateProcess, type PrivateProcess } from "../ask-me/keychain.ts";
import { describeDestination, environmentOverride, loadTelegramConfig, parseDestination, readSettings, resolveDestination, saveSettings, settingsPaths, type SettingsPaths, type SavedDestination } from "../ask-me/settings.ts";

const TOKEN = "123456:MOCK_TOKEN_NOT_A_REAL_CREDENTIAL";
const REF = "12345678-1234-4234-8234-123456789abc";
const NEXT_REF = "12345678-1234-4234-8234-123456789def";
const DESTINATION: SavedDestination = { version: 1, tokenRef: REF, userId: 123, chatId: 123 };
const signal = () => new AbortController().signal;

async function fixture(run: (paths: SettingsPaths, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ask-me-setup-test-"));
	try {
		await mkdir(join(root, "global"), { mode: 0o700 });
		await mkdir(join(root, "project"), { mode: 0o700 });
		await run({ global: join(root, "global", "ask-me.json"), project: join(root, "project", "ask-me.json"), trusted: true }, root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });

function dialog(choices: (string | undefined)[], inputs: (string | undefined)[], confirm = true, token: string | undefined = TOKEN): SetupUI & { shown: string[]; secretReads: number } {
	const shown: string[] = [];
	return {
		shown, secretReads: 0,
		async select(title, options) { shown.push(title, ...options); return choices.shift(); },
		async input(title, placeholder) { shown.push(title, placeholder ?? ""); return inputs.shift(); },
		async confirm(title, detail) { shown.push(title, detail); return confirm; },
		async secret() { this.secretReads++; return token; },
	};
}
function stores(written: { reference: string; token: string }[], fail = false): SetupDependencies {
	return { read: readSettings, save: saveSettings, reference: () => NEXT_REF,
		async writeToken(reference, token) { if (fail) throw new Error(TOKEN); written.push({ reference, token }); },
	};
}

test("masked token typing, paste, invalid format, undo and cancellation never render or serialize secret text", () => {
	for (const chunks of [[TOKEN], [`\x1b[200~${TOKEN}\x1b[201~`], ["\x1b[200~", TOKEN.slice(0, 12), TOKEN.slice(12), "\x1b[201~"]]) {
		const results: (string | undefined)[] = [];
		const input = new MaskedTokenInput((value) => results.push(value), () => {});
		for (const chunk of chunks) {
			input.handleInput(chunk);
			for (const width of [1, 5, 20, 100]) {
				const lines = input.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				assert.ok(!lines.join("\n").includes("MOCK_TOKEN"));
			}
			assert.ok(!JSON.stringify(input).includes(TOKEN));
		}
		input.handleInput("\r");
		assert.deepEqual(results, [TOKEN]);
		input.handleInput("should not be accepted after closing");
		assert.ok(!input.render(100).join("\n").includes(TOKEN));
	}
	const results: (string | undefined)[] = [];
	const invalid = new MaskedTokenInput((value) => results.push(value), () => {});
	invalid.handleInput("MOCK_INVALID_SECRET"); invalid.handleInput("\r");
	assert.equal(results.length, 0);
	assert.match(invalid.render(100).join("\n"), /Invalid token format/);
	assert.ok(!invalid.render(100).join("\n").includes("MOCK_INVALID_SECRET"));
	invalid.handleInput("\u0015"); invalid.handleInput(TOKEN); invalid.handleInput("\u007f"); invalid.handleInput("\u001f");
	assert.ok(!invalid.render(100).join("\n").includes(TOKEN));
	invalid.handleInput("\x1b"); invalid.cancel();
	assert.deepEqual(results, [undefined]);
});

test("masked token rejects oversized paste and control-key cancellation without leaking", () => {
	for (const key of ["\u0003", "\u0004"]) {
		let result: string | undefined = "not cancelled";
		const input = new MaskedTokenInput((value) => { result = value; }, () => {});
		input.handleInput("MOCK_SECRET".repeat(500));
		assert.ok(!input.render(100).join("\n").includes("MOCK_SECRET"));
		input.handleInput(key);
		assert.equal(result, undefined);
	}
});

test("RPC/headless setup rejects before opening unmasked input", async () => {
	for (const mode of ["rpc", "print", "json"] as const) {
		const ctx = { mode, hasUI: mode === "rpc", ui: { input() { throw new Error("must not open"); } } } as never;
		await assert.rejects(maskedToken(ctx, signal()), /local Pi TUI/);
		await assert.rejects(Effect.runPromise(runSetup(ctx, signal())), /local Pi TUI|macOS Keychain/);
	}
});

test("Keychain writes send the token only through stdin; reads validate and all failures are redacted", async () => {
	const calls: { executable: string; args: readonly string[]; input: string | undefined }[] = [];
	const run: PrivateProcess = async (executable, args, input) => { calls.push({ executable, args, input }); return input === undefined ? `${TOKEN}\n` : ""; };
	await writeToken(REF, TOKEN, signal(), run, "darwin");
	assert.equal(await readToken(REF, signal(), run, "darwin"), TOKEN);
	assert.equal(calls[0]?.executable, "/usr/bin/security");
	assert.deepEqual(calls[0]?.args, ["-i", "-q"]);
	assert.ok(calls[0]?.input?.includes(TOKEN));
	assert.ok(!calls[0]?.input?.includes(" -U "));
	assert.ok(calls.every((call) => !JSON.stringify(call.args).includes(TOKEN)));
	assert.equal(calls[1]?.input, undefined);
	const fail: PrivateProcess = async () => { throw new Error(`https://api.telegram.org/bot${TOKEN}/failure`); };
	for (const operation of [writeToken(REF, TOKEN, signal(), fail, "darwin"), readToken(REF, signal(), fail, "darwin"), readToken(REF, signal(), async () => "INVALID_MOCK_SECRET", "darwin")]) {
		await assert.rejects(operation, (error: unknown) => error instanceof Error && /Keychain operation failed/.test(error.message) && !error.message.includes(TOKEN) && !error.message.includes("INVALID_MOCK_SECRET"));
	}
	let invoked = false;
	const forbidden: PrivateProcess = async () => { invoked = true; return ""; };
	await assert.rejects(writeToken(REF, `${TOKEN}\nhelp`, signal(), forbidden, "darwin"));
	await assert.rejects(writeToken("bad reference", TOKEN, signal(), forbidden, "darwin"));
	await assert.rejects(readToken(REF, signal(), forbidden, "linux"));
	assert.equal(invoked, false);
});

test("private subprocess I/O hides stderr, bounds stdout, kills on abort and has its own deadline", async () => {
	assert.equal(await privateProcess(process.execPath, ["-e", "process.stderr.write('MOCK_PRIVATE_ERROR'); process.stdout.write('ok')"], undefined, signal()), "ok");
	await assert.rejects(privateProcess(process.execPath, ["-e", "process.stderr.write('MOCK_PRIVATE_ERROR'); process.exit(1)"], undefined, signal()), (error: unknown) => error instanceof Error && !error.message.includes("MOCK_PRIVATE_ERROR"));
	await assert.rejects(privateProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], undefined, signal()), /Keychain operation failed/);
	const start = Date.now();
	await assert.rejects(privateProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, signal(), 25), /Keychain operation failed/);
	await assert.rejects(privateProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, AbortSignal.timeout(25)), /Keychain operation failed/);
	await assert.rejects(privateProcess("/nonexistent-test-executable", [], undefined, signal()), /Keychain operation failed/);
	assert.ok(Date.now() - start < 3000);
});

test("environment overrides are explicit, complete and never borrow IDs or token from saved settings", async () => {
	await fixture(async (paths) => {
		await put(paths.global, DESTINATION);
		await put(paths.project, { ...DESTINATION, chatId: 456 });
		assert.equal(resolveDestination(paths, {})?.source, "project");
		assert.equal(resolveDestination(paths, { TELEGRAM_BOT_TOKEN: TOKEN })?.source, "project");
		assert.equal(resolveDestination({ ...paths, trusted: false }, {})?.source, "global");
		const env = { MEPIE_ASK_ME_TOKEN_ENV: "MOCK_BOT_TOKEN", MOCK_BOT_TOKEN: TOKEN, MEPIE_ASK_ME_TELEGRAM_USER_ID: "789", MEPIE_ASK_ME_TELEGRAM_CHAT_ID: "789" };
		assert.equal(resolveDestination(paths, env)?.source, "env");
		assert.equal(resolveDestination(paths, env)?.config.chatId, 789);
		await put(paths.global, { invalid: true });
		assert.equal(resolveDestination(paths, {})?.source, "project");
		await put(paths.project, { invalid: true });
		assert.equal(resolveDestination(paths, env)?.source, "env");
		for (const partial of [{ MEPIE_ASK_ME_TOKEN_ENV: "MOCK_BOT_TOKEN" }, { MEPIE_ASK_ME_TELEGRAM_USER_ID: "789", TELEGRAM_BOT_TOKEN: TOKEN }, { MEPIE_ASK_ME_TELEGRAM_CHAT_ID: "" }]) assert.throws(() => resolveDestination(paths, partial), /override is incomplete/);
		assert.equal(environmentOverride({}), undefined);
	});
});

test("invalid, incomplete or unreadable chosen scope fails closed; untrusted project data is not read", async () => {
	await fixture(async (paths, root) => {
		await put(paths.global, DESTINATION);
		await put(paths.project, { version: 1, tokenRef: REF });
		assert.throws(() => resolveDestination(paths, {}), /complete numeric/);
		assert.equal(resolveDestination({ ...paths, trusted: false }, {})?.source, "global");
		await writeFile(paths.project, "{", { mode: 0o600 });
		assert.throws(() => resolveDestination(paths, {}), /invalid JSON/);
		await put(paths.project, DESTINATION); await chmod(paths.project, 0o644);
		assert.throws(() => resolveDestination(paths, {}), /owner-private/);
		await rm(paths.project); await symlink(paths.global, paths.project);
		assert.throws(() => resolveDestination(paths, {}), /cannot be read/);
		assert.equal(resolveDestination({ ...paths, trusted: false }, {})?.source, "global");
		await rm(paths.project); await rm(join(root, "project"), { recursive: true }); await symlink(join(root, "global"), join(root, "project"));
		assert.throws(() => resolveDestination(paths, {}), /directory must be owned/);
	});
	for (const value of [{ ...DESTINATION, token: TOKEN }, { ...DESTINATION, userId: -1 }, { ...DESTINATION, chatId: Number.MAX_SAFE_INTEGER + 1 }, { ...DESTINATION, tokenRef: "../other-item" }]) assert.throws(() => parseDestination(value));
});

test("status reports only nonsecret readiness and reading token is deferred to routing", async () => {
	const destination = { source: "global" as const, config: DESTINATION };
	let reads = 0;
	assert.match(describeDestination(destination, "darwin"), /global.*User ID: 123.*Private chat ID: 123.*credential not checked/);
	assert.match(describeDestination(destination, "linux"), /Not ready: saved Keychain credentials require macOS/);
	assert.ok(!describeDestination(destination).includes(REF));
	assert.equal(reads, 0);
	const config = await Effect.runPromise(loadTelegramConfig(destination, signal(), async () => { reads++; return TOKEN; }));
	assert.equal(config.token, TOKEN); assert.equal(reads, 1);
	assert.ok(!describeDestination({ source: "env", config }).includes(TOKEN));
	await assert.rejects(Effect.runPromise(loadTelegramConfig(destination, signal(), async () => { throw new Error(TOKEN); })), (error: unknown) => error instanceof Error && /no fallback/.test(error.message) && !error.message.includes(TOKEN));
});

test("first-time global setup saves complete private settings and a fresh token only after review", async () => {
	await fixture(async (paths) => {
		const written: { reference: string; token: string }[] = [];
		const ui = dialog(["Global (recommended)"], ["not-an-id", "123", "123"]);
		assert.equal(await setupWizard(ui, paths, signal(), stores(written)), "saved");
		assert.equal(ui.secretReads, 1);
		assert.deepEqual(written, [{ reference: NEXT_REF, token: TOKEN }]);
		assert.deepEqual(readSettings(paths.global).destination, { ...DESTINATION, tokenRef: NEXT_REF });
		assert.equal((await stat(paths.global)).mode & 0o777, 0o600);
		assert.ok(!JSON.stringify(ui.shown).includes(TOKEN));
		assert.ok(!await readFile(paths.global, "utf8").then((raw) => raw.includes(TOKEN)));
		assert.equal(readSettings(paths.project).destination, undefined);
	});
});

test("keep token never reads or rewrites Keychain; replacement uses a new reference", async () => {
	await fixture(async (paths) => {
		await put(paths.global, DESTINATION);
		const written: { reference: string; token: string }[] = [];
		const keep = dialog(["Global (recommended)", "Keep existing token"], ["456", "456"]);
		await setupWizard(keep, paths, signal(), stores(written));
		assert.equal(keep.secretReads, 0); assert.equal(written.length, 0);
		assert.equal(readSettings(paths.global).destination?.tokenRef, REF);
		const replace = dialog(["Global (recommended)", "Replace token"], ["456", "456"]);
		await setupWizard(replace, paths, signal(), stores(written));
		assert.equal(written[0]?.reference, NEXT_REF);
		assert.equal(readSettings(paths.global).destination?.tokenRef, NEXT_REF);
		assert.ok(!replace.shown.join("\n").includes(TOKEN));
	});
});

test("cancellation at each wizard decision writes neither settings nor credentials", async () => {
	for (const ui of [dialog([undefined], []), dialog(["Global (recommended)", undefined], []), dialog(["Global (recommended)", "Replace token"], [undefined]), dialog(["Global (recommended)", "Replace token"], ["123", undefined]), dialog(["Global (recommended)", "Replace token"], ["123", "123"], false)]) {
		await fixture(async (paths) => {
			await put(paths.global, DESTINATION);
			const before = await readFile(paths.global, "utf8");
			const written: { reference: string; token: string }[] = [];
			assert.equal(await setupWizard(ui, paths, signal(), stores(written)), "cancelled");
			assert.equal(await readFile(paths.global, "utf8"), before); assert.equal(written.length, 0);
			assert.deepEqual(await readdir(join(paths.global, "..")), ["ask-me.json"]);
		});
	}
	await fixture(async (paths) => {
		const ui = dialog(["Global (recommended)"], []);
		ui.secret = async () => undefined;
		assert.equal(await setupWizard(ui, paths, signal(), stores([])), "cancelled");
		assert.equal(readSettings(paths.global).raw, undefined);
	});
});

test("project reuse removes only override after confirmation; separate project and trust rules preserve global", async () => {
	await fixture(async (paths) => {
		await put(paths.global, DESTINATION); await put(paths.project, { ...DESTINATION, chatId: 456 });
		const globalBefore = readSettings(paths.global).raw;
		const written: { reference: string; token: string }[] = [];
		const ui = dialog(["This project", "Use global destination (remove project override)"], []);
		assert.equal(await setupWizard(ui, paths, signal(), stores(written)), "inherited");
		assert.equal(readSettings(paths.project).raw, undefined);
		assert.equal(resolveDestination(paths, {})?.source, "global");
		assert.equal(written.length, 0); assert.match(ui.shown.join("\n"), /Keychain items are preserved/);
		const separate = dialog(["This project", "Configure separate project destination"], ["456", "456"]);
		await setupWizard(separate, paths, signal(), stores(written));
		assert.equal(readSettings(paths.project).destination?.userId, 456);
		assert.equal(readSettings(paths.global).raw, globalBefore);
		await assert.rejects(setupWizard(dialog(["This project"], []), { ...paths, trusted: false }, signal(), stores(written)), /Trust this project/);
		const before = readSettings(paths.project).raw;
		assert.equal(await setupWizard(dialog(["This project", "Use global destination (remove project override)"], [], false), paths, signal(), stores(written)), "cancelled");
		assert.equal(readSettings(paths.project).raw, before);
	});
});

test("failed Keychain save preserves old destination and never exposes the thrown secret", async () => {
	await fixture(async (paths) => {
		await put(paths.global, DESTINATION);
		const before = readSettings(paths.global).raw;
		await assert.rejects(setupWizard(dialog(["Global (recommended)", "Replace token"], ["456", "456"]), paths, signal(), stores([], true)), (error: unknown) => error instanceof Error && /Previous configuration was preserved/.test(error.message) && !error.message.includes(TOKEN));
		assert.equal(readSettings(paths.global).raw, before);
		assert.deepEqual(await readdir(join(paths.global, "..")), ["ask-me.json"]);
	});
});

test("atomic saves reject concurrent/stale edits before creating credentials and abort preserves old file", async () => {
	await fixture(async (paths) => {
		await put(paths.global, DESTINATION);
		const original = readSettings(paths.global);
		await put(paths.global, { ...DESTINATION, userId: 456 });
		let calls = 0;
		await assert.rejects(saveSettings(paths.global, original, DESTINATION, async () => { calls++; }, signal()), /changed during setup/);
		assert.equal(calls, 0);
		const current = readSettings(paths.global);
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => { started = resolve; });
		const saving = saveSettings(paths.global, current, DESTINATION, async () => { started?.(); await new Promise<void>((resolve) => { release = resolve; }); }, signal());
		await waiting;
		assert.equal(readSettings(paths.global).raw, current.raw);
		await assert.rejects(saveSettings(paths.global, current, DESTINATION, async () => { calls++; }, signal()), /locked/);
		release?.(); await saving;
		assert.deepEqual(readSettings(paths.global).destination, DESTINATION);
		const controller = new AbortController();
		await assert.rejects(saveSettings(paths.global, readSettings(paths.global), { ...DESTINATION, chatId: 456 }, async () => { controller.abort(); }, controller.signal), /Previous configuration was preserved/);
		assert.deepEqual(readSettings(paths.global).destination, DESTINATION);
		assert.equal(calls, 0);
	});
});

test("ordinary independent Pi instances load trusted saved setup without exports; status and AFK toggle never read tokens", async () => {
	await fixture(async (_paths, root) => {
		await mkdir(join(root, CONFIG_DIR_NAME), { mode: 0o700 });
		await put(join(root, CONFIG_DIR_NAME, "ask-me.json"), DESTINATION);
		let reads = 0;
		for (let instance = 0; instance < 2; instance++) {
			const entries: unknown[] = [];
			const shown: string[] = [];
			let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
			const api = {
				registerFlag() {}, on() {}, getSessionName: () => "mock session",
				appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
				registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
			};
			const ctx: ExtensionCommandContext = {
				cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "mock-session", getBranch: () => [] },
				ui: { notify: (message: string) => shown.push(message), setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
			} as never;
			const remote: typeof remoteQuestionnaire = (request, draft, _label, remoteSignal, _progress, _connection, _env, resolve) => ({
				stop() {},
				result: (async () => {
					assert.ok(resolve);
					const config = await resolve(remoteSignal);
					assert.equal(config.token, TOKEN); assert.equal(config.chatId, 123); assert.equal(config.userId, 123);
					return { details: { ...request, ...draft, status: "cancelled" as const }, handoff: false };
				})(),
			});
			const router = new AskMeRouting(api as never, remote, undefined,
				(destination, abort) => loadTelegramConfig(destination, abort, async () => { reads++; return TOKEN; }),
				(context: ExtensionContext) => resolveDestination(settingsPaths(context), {}));
			assert.ok(command);
			await command("status", ctx); await command("afk on", ctx);
			assert.equal(reads, instance);
			assert.match(shown.join("\n"), /Configuration source: project/);
			assert.ok(!shown.join("\n").includes(TOKEN));
			await router.run(ctx, normalizeAskMeRequest({ questions: [{ id: "q", type: "question", question: "Proceed?" }] }), undefined, async () => { throw new Error("local should not run"); }, () => {});
			assert.equal(reads, instance + 1);
			assert.ok(!JSON.stringify(entries).includes(TOKEN));
		}
	});
});

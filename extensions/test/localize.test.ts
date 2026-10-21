import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { parse } from "yaml";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_LOCALIZE_CONFIG,
	getProjectLocalizeConfigPath,
	loadMergedLocalizeConfig,
	updateProjectLocalizeConfig,
} from "../localize/config.ts";
import { parseLocalizeCommand, registerLocalizeExtension, requestLocalizedPrompt, validateLocalizedStructure } from "../localize/index.ts";

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

test("command parsing requires a mode and preserves prompt whitespace", () => {
	for (const args of ["", "hello", "compose", "refine \n\t", "config extra", "composeX text"]) {
		assert.equal(parseLocalizeCommand(args), undefined);
	}
	assert.deepEqual(parseLocalizeCommand("config \n\t"), { mode: "config" });
	for (const mode of ["compose", "refine"]) {
		const source = "  heading\n\n\t- item\n";
		assert.deepEqual(parseLocalizeCommand(`${mode} ${source}`), { mode, source });
		assert.deepEqual(parseLocalizeCommand(`${mode}\r\n${source}`), { mode, source });
	}
});

function localizeCommand() {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	registerLocalizeExtension({ registerCommand: (name, command) => commands.set(name, command) },
		async () => { throw new Error("Unexpected model call"); });
	assert.deepEqual([...commands.keys()], ["localize"]);
	const command = commands.get("localize");
	assert.ok(command);
	return command;
}

test("command autocomplete filters subcommands and stops after whitespace", async () => {
	const complete = localizeCommand().getArgumentCompletions;
	assert.ok(complete);
	assert.deepEqual((await complete("co"))?.map((item) => item.value), ["compose", "config"]);
	assert.deepEqual((await complete(""))?.map((item) => item.value), ["compose", "refine", "config"]);
	assert.ok((await complete(""))?.every((item) => item.description));
	for (const prefix of ["compose ", "refine\n", "config ", "compose words", "unknown"]) {
		assert.equal(await complete(prefix), null);
	}
});

test("invalid commands show usage without model or config UI calls", async () => {
	const command = localizeCommand();
	const notices: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
	for (const args of ["", "unknown", "compose", "refine \n", "config extra"]) {
		await command.handler(args, ctx as unknown as ExtensionCommandContext);
	}
	assert.equal(notices.length, 5);
	assert.ok(notices.every((text) => text.startsWith("Usage:")));
});

test("both modes restore source on cancellation or config failure and guard non-TUI use", async () => {
	const command = localizeCommand();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-command-"));
	const file = getProjectLocalizeConfigPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "localize:\n  composerPrompt: 42\n");
	for (const trusted of [false, true]) {
		for (const mode of ["compose", "refine"]) {
			let restored: string | undefined;
			let customCalls = 0;
			const ctx = {
				cwd, mode: "tui", hasUI: true, isProjectTrusted: () => trusted,
				ui: {
					notify: () => {},
					setEditorText: (text: string) => { restored = text; },
					custom: async () => { customCalls++; return null; },
				},
			};
			const source = "  first\n\n- second\n";
			await command.handler(`${mode} ${source}`, ctx as unknown as ExtensionCommandContext);
			assert.equal(restored, source);
			assert.equal(customCalls, trusted ? 0 : 1);
		}
	}
	for (const mode of ["rpc", "print", "json"]) {
		const notices: string[] = [];
		const ctx = { mode, hasUI: mode === "rpc", ui: { notify: (text: string) => notices.push(text) } };
		await command.handler("compose instructions", ctx as unknown as ExtensionCommandContext);
		assert.match(notices[0] ?? "", /requires interactive mode/);
	}
});

test("config requires trust before opening settings", async () => {
	const notices: string[] = [];
	await localizeCommand().handler("config", {
		mode: "tui", hasUI: true, isProjectTrusted: () => false,
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionCommandContext);
	assert.match(notices[0] ?? "", /Trust this project/);
});

test("config UI edits both prompts and saves only after confirmation", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	for (const confirmed of [false, true]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-ui-"));
		const titles: string[] = [];
		const ctx = {
			cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true,
			modelRegistry: { refresh: async () => {}, getAvailable: () => [model], find: () => model },
			ui: {
				notify: () => {},
				select: async (_title: string, values: string[]) => values[0],
				editor: async (title: string) => { titles.push(title); return `Edited ${title}`; },
				confirm: async () => confirmed,
			},
		};
		await localizeCommand().handler("config", ctx as unknown as ExtensionCommandContext);
		assert.deepEqual(titles, ["Edit localize composer prompt", "Edit localize refiner prompt"]);
		assert.equal(fs.existsSync(getProjectLocalizeConfigPath(cwd)), confirmed);
		if (confirmed) {
			const config = loadMergedLocalizeConfig(cwd);
			assert.equal(config.composerPrompt, "Edited Edit localize composer prompt");
			assert.equal(config.refinerPrompt, "Edited Edit localize refiner prompt");
		}
	}
});

test("localize config uses package defaults without a project override", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-default-"));
	assert.deepEqual(loadMergedLocalizeConfig(cwd), DEFAULT_LOCALIZE_CONFIG);
});

test("localize config merges project overrides", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-override-"));
	const configPath = getProjectLocalizeConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		"localize:\n  model: anthropic/claude-haiku-4-5\n  thinking: minimal\n  refinerPrompt: Keep it concise.\n",
		"utf-8",
	);

	assert.deepEqual(loadMergedLocalizeConfig(cwd), {
		model: "anthropic/claude-haiku-4-5",
		thinking: "minimal",
		refinerPrompt: "Keep it concise.",
		composerPrompt: DEFAULT_LOCALIZE_CONFIG.composerPrompt,
	});
	assert.deepEqual(loadMergedLocalizeConfig(cwd, { includeProject: false }), DEFAULT_LOCALIZE_CONFIG);
});

test("localize config writes preserve sibling Mepie config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-write-"));
	const configPath = getProjectLocalizeConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		"answer:\n  model: openai-codex/gpt-5.5\n  thinking: medium\nsubagents:\n  enabled: false\n",
		"utf-8",
	);

	updateProjectLocalizeConfig(cwd, {
		composerPrompt: "Compose a prompt.",
		model: "openai-codex/gpt-5.5",
		thinking: "low",
		refinerPrompt: "Refine without expanding.",
	});

	const saved = parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	assert.deepEqual(saved.answer, {
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
	});
	assert.deepEqual(saved.subagents, { enabled: false });
	assert.deepEqual(saved.localize, {
		composerPrompt: "Compose a prompt.",
		model: "openai-codex/gpt-5.5",
		thinking: "low",
		refinerPrompt: "Refine without expanding.",
	});
});

test("composer config round-trips legacy shapes and rejects invalid prompts", () => {
	for (const document of [
		"- extension: localize\n  refinerPrompt: Existing refiner\n- extension: other\n  enabled: true\n",
		"extension: localize\nrefinerPrompt: Existing refiner\ncomposerPrompt: Old composer\nother: true\n",
	]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-legacy-"));
		const file = getProjectLocalizeConfigPath(cwd);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, document);
		const config = { ...loadMergedLocalizeConfig(cwd), composerPrompt: "New composer\nKeep literals." };
		updateProjectLocalizeConfig(cwd, config);
		assert.deepEqual(loadMergedLocalizeConfig(cwd), config);
		const before = fs.readFileSync(file, "utf8");
		assert.throws(() => updateProjectLocalizeConfig(cwd, { ...config, composerPrompt: " \n" }), /composerPrompt/);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}
	for (const value of ["''", "42", "[]", "null"]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-invalid-"));
		const file = getProjectLocalizeConfigPath(cwd);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `localize:\n  composerPrompt: ${value}\n`);
		assert.throws(() => loadMergedLocalizeConfig(cwd), /composerPrompt/);
	}
});

test("compose uses its prompt, allows restructuring, and rejects empty output", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	const modelRegistry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
	};
	const config = { ...DEFAULT_LOCALIZE_CONFIG, composerPrompt: "Compose only." };
	const signal = new AbortController().signal;
	const result = await requestLocalizedPrompt("compose", "fix `foo()`\n\nadd test", config,
		{ modelRegistry } as never, signal, async (_model, context, options) => {
			assert.equal(context.systemPrompt, config.composerPrompt);
			assert.equal(options?.signal, signal);
			return assistantMessage("Fix `foo()` and add a test.");
		});
	assert.equal(result, "Fix `foo()` and add a test.");
	await assert.rejects(requestLocalizedPrompt("compose", "instructions", config,
		{ modelRegistry } as never, signal, async () => assistantMessage(" \n")), /returned no text/);
});

test("structure validation accepts refined prose with matching paragraphs and lists", () => {
	const source = "tolong fix bug ini\n\n- jangan ubah API\n- tambah test";
	const localized = "Please fix this bug.\n\n- Do not change the API.\n- Add tests.";
	assert.deepEqual(validateLocalizedStructure(source, localized), { ok: true });
});

test("structure validation rejects changed line and list structure", () => {
	assert.deepEqual(
		validateLocalizedStructure("first\n\nsecond", "First and second"),
		{ ok: false, reason: "line count changed" },
	);
	assert.deepEqual(
		validateLocalizedStructure("- first\n- second", "1. First\n2. Second"),
		{ ok: false, reason: "formatting changed at line 1" },
	);
});

test("structure validation rejects changes inside fenced code", () => {
	const source = "Run this:\n```ts\nconst value = 1;\n```";
	const localized = "Run this command:\n```ts\nconst value = 2;\n```";
	assert.deepEqual(validateLocalizedStructure(source, localized), {
		ok: false,
		reason: "fenced code changed at line 3",
	});
});

test("structure validation preserves inline code, URLs, and paths", () => {
	const source = "ubah `createUser()` di ./src/user.ts dan lihat https://example.com/docs";
	const localized = "Change `createAccount()` in ./src/account.ts and see https://example.com/docs";
	assert.deepEqual(validateLocalizedStructure(source, localized), {
		ok: false,
		reason: "inline code, URL, or path changed",
	});
	assert.deepEqual(
		validateLocalizedStructure(
			String.raw`buka C:\temp\file.txt atau \\server\share\file.txt`,
			String.raw`Open C:\temp\other.txt or \\server\share\other.txt`,
		),
		{ ok: false, reason: "inline code, URL, or path changed" },
	);
});

test("requestLocalizedPrompt uses the configured model, prompt, and low thinking", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	let capturedContext: Context | undefined;
	let capturedOptions: SimpleStreamOptions | undefined;
	const complete = async (
		_model: typeof model,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		capturedContext = context;
		capturedOptions = options;
		return assistantMessage("Please fix this bug.\n\n- Keep the API unchanged.");
	};
	const source = "tolong fix bug ini\n\n- jangan ubah API";
	const config = {
		...DEFAULT_LOCALIZE_CONFIG,
		refinerPrompt: "Translate and refine only.",
	};
	const modelRegistry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token", headers: { test: "yes" } }),
	};

	const result = await requestLocalizedPrompt(
		"refine",
		source,
		config,
		{ modelRegistry } as never,
		new AbortController().signal,
		complete as never,
	);

	assert.equal(result, "Please fix this bug.\n\n- Keep the API unchanged.");
	assert.equal(capturedContext?.systemPrompt, "Translate and refine only.");
	assert.equal((capturedContext?.messages[0] as { content: Array<{ text: string }> }).content[0]?.text, source);
	assert.equal(capturedOptions?.reasoning, "low");
	assert.equal(capturedOptions?.apiKey, "token");
	assert.deepEqual(capturedOptions?.headers, { test: "yes" });
});

test("requestLocalizedPrompt falls back to the current session model", async () => {
	const currentModel = getModel("openai-codex", "gpt-5.5");
	assert.ok(currentModel);
	let selectedModel: typeof currentModel | undefined;
	const modelRegistry = {
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
	};

	const result = await requestLocalizedPrompt(
		"refine",
		"tolong perbaiki bug",
		{ ...DEFAULT_LOCALIZE_CONFIG, model: "missing/model" },
		{ modelRegistry, model: currentModel } as never,
		new AbortController().signal,
		(async (model: Model<Api>) => {
			selectedModel = model as typeof currentModel;
			return assistantMessage("Please fix the bug.");
		}) as never,
	);

	assert.equal(selectedModel, currentModel);
	assert.equal(result, "Please fix the bug.");
});

test("requestLocalizedPrompt rejects output that changes structure", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	const modelRegistry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
	};

	await assert.rejects(
		requestLocalizedPrompt(
			"refine",
			"first\n\nsecond",
			DEFAULT_LOCALIZE_CONFIG,
			{ modelRegistry } as never,
			new AbortController().signal,
			(async () => assistantMessage("First and second.")) as never,
		),
		/changed the prompt structure: line count changed/,
	);
});

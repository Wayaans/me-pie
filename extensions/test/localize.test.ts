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
import {
	DEFAULT_LOCALIZE_CONFIG,
	getProjectLocalizeConfigPath,
	loadMergedLocalizeConfig,
	updateProjectLocalizeConfig,
} from "../localize/config.ts";
import { requestLocalizedPrompt, validateLocalizedStructure } from "../localize/index.ts";

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.4-mini",
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
	});
	assert.deepEqual(loadMergedLocalizeConfig(cwd, { includeProject: false }), DEFAULT_LOCALIZE_CONFIG);
});

test("localize config writes preserve sibling Mepie config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-localize-write-"));
	const configPath = getProjectLocalizeConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		"answer:\n  model: openai-codex/gpt-5.4-mini\n  thinking: medium\nsubagents:\n  enabled: false\n",
		"utf-8",
	);

	updateProjectLocalizeConfig(cwd, {
		model: "openai-codex/gpt-5.4-mini",
		thinking: "low",
		refinerPrompt: "Refine without expanding.",
	});

	const saved = parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	assert.deepEqual(saved.answer, {
		model: "openai-codex/gpt-5.4-mini",
		thinking: "medium",
	});
	assert.deepEqual(saved.subagents, { enabled: false });
	assert.deepEqual(saved.localize, {
		model: "openai-codex/gpt-5.4-mini",
		thinking: "low",
		refinerPrompt: "Refine without expanding.",
	});
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
	const model = getModel("openai-codex", "gpt-5.4-mini");
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
	const currentModel = getModel("openai-codex", "gpt-5.4-mini");
	assert.ok(currentModel);
	let selectedModel: typeof currentModel | undefined;
	const modelRegistry = {
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
	};

	const result = await requestLocalizedPrompt(
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
	const model = getModel("openai-codex", "gpt-5.4-mini");
	const modelRegistry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }),
	};

	await assert.rejects(
		requestLocalizedPrompt(
			"first\n\nsecond",
			DEFAULT_LOCALIZE_CONFIG,
			{ modelRegistry } as never,
			new AbortController().signal,
			(async () => assistantMessage("First and second.")) as never,
		),
		/changed the prompt structure: line count changed/,
	);
});

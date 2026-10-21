import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type {
	AssistantMessage,
	Context,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	collectCheckpointFileState,
	createCheckpointDetails,
	resolvePreviousCheckpoint,
} from "../checkpoint-compaction/checkpoint.ts";
import { createCheckpointCompactionHandler } from "../checkpoint-compaction/index.ts";
import {
	buildCheckpointInput,
	CHECKPOINT_HEADINGS,
	CHECKPOINT_SYSTEM_PROMPT,
	CONTINUATION_PREFIX,
	renderCompactionSummary,
	validateCheckpoint,
} from "../checkpoint-compaction/prompt.ts";
import {
	CHECKPOINT_MAX_OUTPUT_TOKENS,
	CHECKPOINT_REQUEST_TIMEOUT_MS,
	generateCheckpoint,
} from "../checkpoint-compaction/summarizer.ts";

const VALID_CHECKPOINT = `${CHECKPOINT_HEADINGS[0]}
Continue the task.

${CHECKPOINT_HEADINGS[1]}
- Keep the API stable.

${CHECKPOINT_HEADINGS[2]}
- [x] Inspected the implementation.

${CHECKPOINT_HEADINGS[3]}
- Preserve native retention.

${CHECKPOINT_HEADINGS[4]}
The prompt is ready.

${CHECKPOINT_HEADINGS[5]}
1. Implement tests.

${CHECKPOINT_HEADINGS[6]}
- src/example.ts

${CHECKPOINT_HEADINGS[7]}
- Model output remains unverified.`;

function usage(multiplier = 1): Usage {
	return {
		input: 10 * multiplier,
		output: 5 * multiplier,
		cacheRead: 2 * multiplier,
		cacheWrite: 1 * multiplier,
		reasoning: 3 * multiplier,
		totalTokens: 18 * multiplier,
		cost: {
			input: 0.01 * multiplier,
			output: 0.02 * multiplier,
			cacheRead: 0.003 * multiplier,
			cacheWrite: 0.004 * multiplier,
			total: 0.037 * multiplier,
		},
	};
}

function assistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function compactionEvent(signal = new AbortController().signal): SessionBeforeCompactEvent {
	const message = {
		role: "user" as const,
		content: "Implement the checkpoint extension.",
		timestamp: Date.now(),
	};
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [message],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: {
				read: new Set(["src/read.ts"]),
				written: new Set<string>(),
				edited: new Set(["src/edited.ts"]),
			},
			settings: {
				enabled: true,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			},
		},
		branchEntries: [
			{
				type: "message",
				id: "old-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				message,
			},
		],
		reason: "manual",
		willRetry: false,
		signal,
	};
}

function extensionContext(
	notifications: string[],
): ExtensionContext {
	const model = getModel("openai-codex", "gpt-5.5");
	assert.ok(model);
	return {
		model,
		thinkingLevel: "medium",
		hasUI: true,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "token",
				headers: { "x-test": "yes" },
				env: { REGION: "test" },
			}),
		},
		ui: {
			notify: (message: string) => notifications.push(message),
		},
	} as never;
}

test("checkpoint system prompt starts with the required instruction", () => {
	assert.equal(
		CHECKPOINT_SYSTEM_PROMPT.startsWith(
			"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
		),
		true,
	);
	for (const heading of CHECKPOINT_HEADINGS) assert.match(CHECKPOINT_SYSTEM_PROMPT, new RegExp(heading));
});

test("checkpoint input includes iterative, split-turn, file, and custom context", () => {
	const input = buildCheckpointInput({
		conversation: "[User]: Continue",
		previousCheckpoint: VALID_CHECKPOINT,
		customInstructions: "Focus on tests",
		isSplitTurn: true,
		fileState: {
			readFiles: ["src/read.ts"],
			modifiedFiles: ["src/changed.ts"],
		},
	});

	assert.match(input, /<previous-checkpoint>/);
	assert.match(input, /split-turn="true"/);
	assert.match(input, /recent suffix is retained separately/);
	assert.match(input, /src\/read\.ts/);
	assert.match(input, /src\/changed\.ts/);
	assert.match(input, /<additional-focus>\nFocus on tests/);
});

test("checkpoint validation enforces all headings in order", () => {
	assert.deepEqual(validateCheckpoint(VALID_CHECKPOINT), {
		ok: true,
		checkpoint: VALID_CHECKPOINT,
	});
	assert.deepEqual(validateCheckpoint("## Objective\nOnly one section"), {
		ok: false,
		reason: "expected exactly 8 level-two sections, received 1",
	});
	assert.equal(
		validateCheckpoint(VALID_CHECKPOINT.replace(
			"## Decisions",
			"## Unexpected\nExtra content.\n\n## Decisions",
		)).ok,
		false,
	);
	assert.equal(validateCheckpoint(`\`\`\`markdown\n${VALID_CHECKPOINT}\n\`\`\``).ok, true);
});

test("rendered summary adds one continuation prefix and deterministic file lists", () => {
	const summary = renderCompactionSummary(VALID_CHECKPOINT, {
		readFiles: ["src/read.ts"],
		modifiedFiles: ["src/changed.ts"],
	});
	assert.equal(summary.split(CONTINUATION_PREFIX).length - 1, 1);
	assert.match(summary, /<context-checkpoint>/);
	assert.match(summary, /<read-files>\nsrc\/read\.ts\n<\/read-files>/);
	assert.match(summary, /<modified-files>\nsrc\/changed\.ts\n<\/modified-files>/);
});

test("checkpoint state carries raw previous checkpoint and cumulative file operations", () => {
	const event = compactionEvent();
	const previousDetails = createCheckpointDetails(VALID_CHECKPOINT, {
		readFiles: ["src/previous-read.ts", "src/edited.ts"],
		modifiedFiles: ["src/previous-write.ts"],
	});
	const previousCompaction: SessionEntry = {
		type: "compaction",
		id: "compaction-entry",
		parentId: "old-entry",
		timestamp: new Date().toISOString(),
		summary: `${CONTINUATION_PREFIX}\n${VALID_CHECKPOINT}`,
		firstKeptEntryId: "old-entry",
		tokensBefore: 80_000,
		details: previousDetails,
	};
	const preparation = {
		...event.preparation,
		previousSummary: previousCompaction.summary,
		turnPrefixMessages: [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, id: "1", name: "write", arguments: { path: "src/prefix.ts" } },
				],
				api: "openai-codex-responses" as const,
				provider: "openai-codex",
				model: "gpt-5.5",
				usage: usage(),
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
		],
	};
	const branch = [...event.branchEntries, previousCompaction];

	assert.equal(resolvePreviousCheckpoint(preparation, branch), VALID_CHECKPOINT);
	assert.deepEqual(collectCheckpointFileState(preparation, branch), {
		readFiles: ["src/previous-read.ts", "src/read.ts"],
		modifiedFiles: [
			"src/edited.ts",
			"src/prefix.ts",
			"src/previous-write.ts",
		],
	});
});

test("checkpoint generation retries one invalid response and accounts for both attempts", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	assert.ok(model);
	const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
	let callCount = 0;
	const complete = async (
		_model: typeof model,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		calls.push({ context, ...(options ? { options } : {}) });
		callCount++;
		return assistantMessage(callCount === 1 ? "" : VALID_CHECKPOINT);
	};
	const controller = new AbortController();

	const result = await Effect.runPromise(generateCheckpoint({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "token",
				headers: { "x-test": "yes" },
				env: { REGION: "test" },
			}),
		} as never,
		input: "summarize",
		reserveTokens: 16_384,
		thinkingLevel: "medium",
		signal: controller.signal,
		complete: complete as never,
	}));

	assert.equal(result.checkpoint, VALID_CHECKPOINT);
	assert.equal(result.attempts, 2);
	assert.deepEqual(result.usage, usage(2));
	assert.equal(calls[0]?.context.systemPrompt, CHECKPOINT_SYSTEM_PROMPT);
	assert.match(
		(calls[1]?.context.messages[0] as { content: Array<{ text: string }> }).content[0]!.text,
		/previous checkpoint attempt failed or was incomplete/,
	);
	assert.equal(calls[0]?.options?.reasoning, "medium");
	assert.equal(calls[0]?.options?.cacheRetention, "none");
	assert.equal(calls[0]?.options?.maxRetries, 0);
	assert.equal(calls[0]?.options?.timeoutMs, CHECKPOINT_REQUEST_TIMEOUT_MS);
	assert.ok((calls[0]?.options?.maxTokens ?? Infinity) <= CHECKPOINT_MAX_OUTPUT_TOKENS);
});

test("checkpoint generation does not call the model after cancellation", async () => {
	const model = getModel("openai-codex", "gpt-5.5");
	assert.ok(model);
	const controller = new AbortController();
	controller.abort();
	let calls = 0;

	await assert.rejects(
		Effect.runPromise(generateCheckpoint({
			model,
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "token" }) } as never,
			input: "summarize",
			reserveTokens: 16_384,
			signal: controller.signal,
			complete: (async () => {
				calls++;
				return assistantMessage(VALID_CHECKPOINT);
			}) as never,
		})),
	);
	assert.equal(calls, 0);
});

test("compaction handler falls back to Pi after two custom failures", async () => {
	const notifications: string[] = [];
	let calls = 0;
	const handler = createCheckpointCompactionHandler(async () => {
		calls++;
		throw new Error("provider unavailable");
	});

	const result = await handler(compactionEvent(), extensionContext(notifications));
	assert.equal(result, undefined);
	assert.equal(calls, 2);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!, /using Pi default:.*provider unavailable/);
});

test("compaction handler cancels without retry or fallback when aborted in flight", async () => {
	const notifications: string[] = [];
	const controller = new AbortController();
	let calls = 0;
	const handler = createCheckpointCompactionHandler(async (_model, _context, options) => {
		calls++;
		return new Promise<AssistantMessage>((_resolve, reject) => {
			if (options?.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	});

	const pending = handler(compactionEvent(controller.signal), extensionContext(notifications));
	await Promise.resolve();
	controller.abort();
	const result = await pending;

	assert.deepEqual(result, { cancel: true });
	assert.equal(calls, 1);
	assert.deepEqual(notifications, []);
});

test("compaction handler uses the registry completion API when available", async () => {
	const notifications: string[] = [];
	const ctx = extensionContext(notifications);
	let calls = 0;
	(ctx.modelRegistry as unknown as { complete: typeof complete }).complete = complete;

	async function complete(): Promise<AssistantMessage> {
		calls++;
		return assistantMessage(VALID_CHECKPOINT);
	}

	const result = await createCheckpointCompactionHandler()(compactionEvent(), ctx);
	assert.ok(result && "compaction" in result);
	assert.equal(calls, 1);
});

test("compaction handler returns Pi preparation boundaries on success", async () => {
	const notifications: string[] = [];
	const handler = createCheckpointCompactionHandler(async () => assistantMessage(VALID_CHECKPOINT));
	const result = await handler(compactionEvent(), extensionContext(notifications));

	assert.ok(result && "compaction" in result);
	assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
	assert.equal(result.compaction.tokensBefore, 100_000);
	assert.match(result.compaction.summary, /Another model previously worked on this task/);
	assert.deepEqual(result.compaction.details, {
		kind: "checkpoint-compaction",
		version: 1,
		checkpoint: VALID_CHECKPOINT,
		readFiles: ["src/read.ts"],
		modifiedFiles: ["src/edited.ts"],
	});
	assert.deepEqual(notifications, []);
});

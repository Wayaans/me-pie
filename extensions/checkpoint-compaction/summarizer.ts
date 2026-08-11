import { Data, Effect } from "effect";
import {
	clampThinkingLevel,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
	type Usage,
	type UserMessage,
	uuidv7,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_SYSTEM_PROMPT, validateCheckpoint } from "./prompt.ts";

export const CHECKPOINT_MAX_OUTPUT_TOKENS = 8192;
export const CHECKPOINT_REQUEST_TIMEOUT_MS = 120_000;

export class CheckpointAuthError extends Data.TaggedError("CheckpointAuthError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class CheckpointAttemptError extends Data.TaggedError("CheckpointAttemptError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class CheckpointCancelled extends Data.TaggedError("CheckpointCancelled")<{
	readonly message: string;
}> {}

export type CompleteCheckpoint = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface GenerateCheckpointOptions {
	model: Model<Api>;
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">;
	input: string;
	reserveTokens: number;
	thinkingLevel?: ModelThinkingLevel;
	signal: AbortSignal;
	complete?: CompleteCheckpoint;
}

export interface GeneratedCheckpoint {
	checkpoint: string;
	usage: Usage;
	attempts: number;
}

function optionalSum(left: number | undefined, right: number | undefined): number | undefined {
	return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

export function combineUsage(left: Usage | undefined, right: Usage): Usage {
	if (!left) return right;
	const cacheWrite1h = optionalSum(left.cacheWrite1h, right.cacheWrite1h);
	const reasoning = optionalSum(left.reasoning, right.reasoning);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function outputTokenBudget(model: Model<Api>, reserveTokens: number): number {
	const limits = [CHECKPOINT_MAX_OUTPUT_TOKENS, Math.floor(reserveTokens * 0.8)];
	if (model.maxTokens > 0) limits.push(model.maxTokens);
	return Math.max(1, Math.min(...limits));
}

function responseText(response: AssistantMessage): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function generateCheckpoint(
	options: GenerateCheckpointOptions,
): Effect.Effect<GeneratedCheckpoint, CheckpointAuthError | CheckpointAttemptError | CheckpointCancelled> {
	return Effect.gen(function*() {
		if (options.signal.aborted) {
			return yield* new CheckpointCancelled({ message: "Checkpoint compaction cancelled" });
		}

		const auth = yield* Effect.tryPromise({
			try: () => options.modelRegistry.getApiKeyAndHeaders(options.model),
			catch: (error) => new CheckpointAuthError({
				message: `Could not resolve ${options.model.provider}/${options.model.id} authentication: ${failureMessage(error)}`,
				cause: error,
			}),
		});
		if (!auth.ok) {
			return yield* new CheckpointAuthError({ message: auth.error });
		}

		const complete = options.complete ?? (completeSimple as CompleteCheckpoint);
		const resolvedThinking = clampThinkingLevel(
			options.model,
			options.thinkingLevel ?? "off",
		);
		let combinedUsage: Usage | undefined;
		let attempts = 0;

		const attempt = (
			attemptNumber: number,
		): Effect.Effect<string, CheckpointAttemptError | CheckpointCancelled> => {
			const retryInstruction = attemptNumber === 1
				? ""
				: "\n\nThe previous checkpoint attempt failed or was incomplete. Produce a complete checkpoint within the available output budget.";
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: options.input + retryInstruction }],
				timestamp: Date.now(),
			};

			return Effect.tryPromise({
				try: () => {
					attempts++;
					return complete(
						options.model,
						{ systemPrompt: CHECKPOINT_SYSTEM_PROMPT, messages: [userMessage] },
						{
							apiKey: auth.apiKey ?? "",
							...(auth.headers ? { headers: auth.headers } : {}),
							...(auth.env ? { env: auth.env } : {}),
							...(resolvedThinking === "off" ? {} : { reasoning: resolvedThinking }),
							maxTokens: outputTokenBudget(options.model, options.reserveTokens),
							signal: options.signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
							timeoutMs: CHECKPOINT_REQUEST_TIMEOUT_MS,
							maxRetries: 0,
						},
					);
				},
				catch: (error) => options.signal.aborted
					? new CheckpointCancelled({ message: "Checkpoint compaction cancelled" })
					: new CheckpointAttemptError({
							message: `Checkpoint generation attempt ${attemptNumber} failed: ${failureMessage(error)}`,
							cause: error,
						}),
			}).pipe(
				Effect.flatMap((response): Effect.Effect<
					string,
					CheckpointAttemptError | CheckpointCancelled
				> => {
					combinedUsage = combineUsage(combinedUsage, response.usage);
					if (response.stopReason === "aborted" || options.signal.aborted) {
						return Effect.fail(new CheckpointCancelled({ message: "Checkpoint compaction cancelled" }));
					}
					if (response.stopReason !== "stop") {
						return Effect.fail(new CheckpointAttemptError({
							message: response.errorMessage
								?? `Checkpoint generation stopped with ${response.stopReason}`,
						}));
					}

					const validation = validateCheckpoint(responseText(response));
					if (!validation.ok || !validation.checkpoint) {
						return Effect.fail(new CheckpointAttemptError({
							message: validation.reason ?? "The checkpoint response was invalid",
						}));
					}
					return Effect.succeed(validation.checkpoint);
				}),
			);
		};

		const checkpoint = yield* attempt(1).pipe(
			Effect.catchTag("CheckpointAttemptError", () => attempt(2)),
		);
		return {
			checkpoint,
			usage: combinedUsage!,
			attempts,
		};
	});
}

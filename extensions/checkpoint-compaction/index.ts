import { Effect } from "effect";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	collectCheckpointFileState,
	createCheckpointDetails,
	resolvePreviousCheckpoint,
} from "./checkpoint.ts";
import { buildCheckpointInput, renderCompactionSummary } from "./prompt.ts";
import {
	type CompleteCheckpoint,
	CheckpointCancelled,
	generateCheckpoint,
} from "./summarizer.ts";
import type { CheckpointCompactionDetails } from "./types.ts";

export type CheckpointCompactionHandlerResult =
	| { cancel: true }
	| { compaction: CompactionResult<CheckpointCompactionDetails> }
	| undefined;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notifyFallback(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`Checkpoint compaction failed; using Pi default: ${message}`, "warning");
}

function getRegistryComplete(ctx: ExtensionContext): CompleteCheckpoint | undefined {
	const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
		complete?: CompleteCheckpoint;
	};
	return registry.complete?.bind(ctx.modelRegistry);
}

export function createCheckpointCompactionHandler(complete?: CompleteCheckpoint) {
	return async (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	): Promise<CheckpointCompactionHandlerResult> => {
		if (!ctx.model) {
			notifyFallback(ctx, "no active model");
			return undefined;
		}

		const { preparation } = event;
		const messages = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		const conversation = serializeConversation(convertToLlm(messages));
		if (!conversation.trim()) {
			notifyFallback(ctx, "there were no serializable messages");
			return undefined;
		}

		const fileState = collectCheckpointFileState(preparation, event.branchEntries);
		const previousCheckpoint = resolvePreviousCheckpoint(preparation, event.branchEntries);
		const input = buildCheckpointInput({
			conversation,
			fileState,
			...(previousCheckpoint ? { previousCheckpoint } : {}),
			...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
			isSplitTurn: preparation.isSplitTurn,
		});

		try {
			const activeComplete = complete ?? getRegistryComplete(ctx);
			const generated = await Effect.runPromise(
				generateCheckpoint({
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					input,
					reserveTokens: preparation.settings.reserveTokens,
					...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
					signal: event.signal,
					...(activeComplete ? { complete: activeComplete } : {}),
				}),
				{ signal: event.signal },
			);

			return {
				compaction: {
					summary: renderCompactionSummary(generated.checkpoint, fileState),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: generated.usage,
					details: createCheckpointDetails(generated.checkpoint, fileState),
				},
			};
		} catch (error) {
			if (event.signal.aborted || error instanceof CheckpointCancelled) {
				return { cancel: true };
			}
			notifyFallback(ctx, errorMessage(error));
			return undefined;
		}
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_before_compact", createCheckpointCompactionHandler());
}

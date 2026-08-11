import type {
	FileOperations,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_COMPACTION_KIND,
	CHECKPOINT_COMPACTION_VERSION,
	type CheckpointCompactionDetails,
	type CheckpointFileState,
} from "./types.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function latestCompaction(branchEntries: SessionEntry[]): Extract<SessionEntry, { type: "compaction" }> | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

export function isCheckpointCompactionDetails(
	value: unknown,
): value is CheckpointCompactionDetails {
	if (!isRecord(value)) return false;
	return (
		value.kind === CHECKPOINT_COMPACTION_KIND &&
		value.version === CHECKPOINT_COMPACTION_VERSION &&
		typeof value.checkpoint === "string" &&
		Array.isArray(value.readFiles) &&
		value.readFiles.every((path) => typeof path === "string") &&
		Array.isArray(value.modifiedFiles) &&
		value.modifiedFiles.every((path) => typeof path === "string")
	);
}

export function resolvePreviousCheckpoint(
	preparation: CompactionPreparation,
	branchEntries: SessionEntry[],
): string | undefined {
	if (!preparation.previousSummary?.trim()) return undefined;
	const details = latestCompaction(branchEntries)?.details;
	if (isCheckpointCompactionDetails(details) && details.checkpoint.trim()) {
		return details.checkpoint;
	}
	return preparation.previousSummary;
}

function addPreparedFileOperations(
	fileOperations: FileOperations,
	readFiles: Set<string>,
	modifiedFiles: Set<string>,
): void {
	for (const path of fileOperations.read) readFiles.add(path);
	for (const path of fileOperations.written) modifiedFiles.add(path);
	for (const path of fileOperations.edited) modifiedFiles.add(path);
}

function addMessageFileOperations(
	messages: readonly unknown[],
	readFiles: Set<string>,
	modifiedFiles: Set<string>,
): void {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) continue;
			const path = block.arguments.path;
			if (typeof path !== "string" || !path) continue;
			if (block.name === "read") readFiles.add(path);
			if (block.name === "write" || block.name === "edit") modifiedFiles.add(path);
		}
	}
}

function addPreviousFileState(
	branchEntries: SessionEntry[],
	readFiles: Set<string>,
	modifiedFiles: Set<string>,
): void {
	const details = latestCompaction(branchEntries)?.details;
	if (!isRecord(details)) return;
	for (const path of stringArray(details.readFiles)) readFiles.add(path);
	for (const path of stringArray(details.modifiedFiles)) modifiedFiles.add(path);
}

export function collectCheckpointFileState(
	preparation: CompactionPreparation,
	branchEntries: SessionEntry[],
): CheckpointFileState {
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();
	addPreviousFileState(branchEntries, readFiles, modifiedFiles);
	addPreparedFileOperations(preparation.fileOps, readFiles, modifiedFiles);
	addMessageFileOperations(
		[...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
		readFiles,
		modifiedFiles,
	);

	for (const path of modifiedFiles) readFiles.delete(path);
	return {
		readFiles: [...readFiles].sort(),
		modifiedFiles: [...modifiedFiles].sort(),
	};
}

export function createCheckpointDetails(
	checkpoint: string,
	fileState: CheckpointFileState,
): CheckpointCompactionDetails {
	return {
		kind: CHECKPOINT_COMPACTION_KIND,
		version: CHECKPOINT_COMPACTION_VERSION,
		checkpoint,
		readFiles: [...fileState.readFiles],
		modifiedFiles: [...fileState.modifiedFiles],
	};
}

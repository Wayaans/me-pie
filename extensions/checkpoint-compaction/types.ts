export const CHECKPOINT_COMPACTION_KIND = "checkpoint-compaction" as const;
export const CHECKPOINT_COMPACTION_VERSION = 1 as const;

export interface CheckpointFileState {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CheckpointCompactionDetails extends CheckpointFileState {
	kind: typeof CHECKPOINT_COMPACTION_KIND;
	version: typeof CHECKPOINT_COMPACTION_VERSION;
	/** Raw generated checkpoint without Pi's continuation wrapper. */
	checkpoint: string;
}

import { Data } from "effect";

export class ValidationError extends Data.TaggedError("ValidationError")<{
	readonly message: string;
	readonly path?: string;
}> {}

export class IllegalTransitionError extends Data.TaggedError("IllegalTransitionError")<{
	readonly entity: "run" | "work-item";
	readonly from: string;
	readonly to: string;
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
	readonly operation: string;
	readonly path: string;
	readonly cause: unknown;
}> {}

export class CorruptDataError extends Data.TaggedError("CorruptDataError")<{
	readonly path: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class UnsupportedVersionError extends Data.TaggedError("UnsupportedVersionError")<{
	readonly path: string;
	readonly expected: number;
	readonly actual: unknown;
}> {}

export class LockContentionError extends Data.TaggedError("LockContentionError")<{
	readonly path: string;
	readonly owner?: unknown;
}> {}

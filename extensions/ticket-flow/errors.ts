import { Data } from "effect";

export class TicketflowValidationError extends Data.TaggedError("TicketflowValidationError")<{
	readonly message: string;
	readonly path?: string;
}> {}

export class TicketflowPersistenceError extends Data.TaggedError("TicketflowPersistenceError")<{
	readonly operation: string;
	readonly path: string;
	readonly cause: unknown;
}> {}

export class TicketflowTransitionError extends Data.TaggedError("TicketflowTransitionError")<{
	readonly message: string;
}> {}

export class TicketflowTransportError extends Data.TaggedError("TicketflowTransportError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class TicketflowBackendError extends Data.TaggedError("TicketflowBackendError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class TicketflowGitError extends Data.TaggedError("TicketflowGitError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

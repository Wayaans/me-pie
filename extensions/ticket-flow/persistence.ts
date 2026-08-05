import { Effect } from "effect";
import type { WorkflowRun } from "./domain.ts";
import { appendEvent, eventAppendMayHaveWritten, makeWorkflowEvent } from "./event-store.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { ensureRunDirectories, markPendingSnapshotStarted, saveRun, stagePendingSnapshot, clearPendingSnapshot } from "./state-store.ts";
import type { WorkflowPaths } from "./paths.ts";
import { normalizePlan, validateRun } from "./state-machine.ts";

/**
 * The durable state transaction used by the controller.  It is intentionally
 * independent of ownership/transport state: journal append, snapshot staging,
 * and recovery metadata form one cohesive persistence boundary.
 */
export function persistWorkflowTransaction(
	paths: WorkflowPaths,
	next: WorkflowRun,
	eventType: string,
	data: unknown,
): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const normalized: WorkflowRun = { ...next, plan: normalizePlan(next.plan) };
		yield* validateRun(normalized);
		const event = yield* makeWorkflowEvent(normalized.id, eventType, data);
		yield* ensureRunDirectories(paths);
		yield* stagePendingSnapshot(paths, normalized, event);
		yield* markPendingSnapshotStarted(paths);
		yield* appendEvent(paths.eventsFile, event).pipe(
			Effect.onError((cause) => eventAppendMayHaveWritten(cause)
				? Effect.void
				: clearPendingSnapshot(paths).pipe(Effect.catch(() => Effect.void))),
		);
		yield* saveRun(paths, normalized);
		yield* clearPendingSnapshot(paths);
		return normalized;
	});
}

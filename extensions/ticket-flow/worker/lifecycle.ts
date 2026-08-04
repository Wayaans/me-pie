import path from "node:path";
import { Data, Effect } from "effect";
import { THINKING_LEVELS, type PiLaunchProfile } from "../domain.ts";

export interface WorkerStartupEnvironment {
	readonly runId: string;
	readonly workItemId: string;
	readonly requestedProfile: PiLaunchProfile;
	readonly socketPath: string;
	readonly token: string;
}

export class WorkerEnvironmentError extends Data.TaggedError("WorkerEnvironmentError")<{
	readonly variable: string;
	readonly message: string;
}> {}

export class WorkerLifecycleError extends Data.TaggedError("WorkerLifecycleError")<{
	readonly message: string;
}> {}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name];
	if (value === undefined || value.length === 0) {
		throw new WorkerEnvironmentError({ variable: name, message: `${name} is required in Ticket Flow worker role.` });
	}
	if (value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new WorkerEnvironmentError({ variable: name, message: `${name} contains invalid whitespace or control characters.` });
	}
	return value;
}

export function readWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env): WorkerStartupEnvironment {
	if (environment.MEPIE_WORKFLOW_ROLE !== "worker") {
		throw new WorkerEnvironmentError({
			variable: "MEPIE_WORKFLOW_ROLE",
			message: "MEPIE_WORKFLOW_ROLE must be exactly 'worker' before preparing worker lifecycle.",
		});
	}
	const runId = required(environment, "MEPIE_WORKFLOW_RUN_ID");
	const workItemId = required(environment, "MEPIE_WORKFLOW_ITEM_ID");
	const model = required(environment, "MEPIE_WORKFLOW_REQUESTED_MODEL");
	const thinking = required(environment, "MEPIE_WORKFLOW_REQUESTED_THINKING");
	const socketPath = required(environment, "MEPIE_WORKFLOW_SOCKET");
	const token = required(environment, "MEPIE_WORKFLOW_TOKEN");
	if (!/^[^/\s]+\/[^/\s]+$/.test(model)) {
		throw new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_REQUESTED_MODEL", message: "The requested model must be an exact provider/model identifier." });
	}
	if (!THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
		throw new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_REQUESTED_THINKING", message: `Unsupported requested thinking level: ${thinking}` });
	}
	if (!path.isAbsolute(socketPath)) {
		throw new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_SOCKET", message: "The workflow socket path must be absolute." });
	}
	return {
		runId,
		workItemId,
		requestedProfile: { model, thinking: thinking as PiLaunchProfile["thinking"] },
		socketPath,
		token,
	};
}

export class WorkerLifecycle {
	private started = false;
	private released = false;

	constructor(readonly environment: WorkerStartupEnvironment) {}

	start(): Effect.Effect<this, WorkerLifecycleError> {
		if (this.released) return Effect.fail(new WorkerLifecycleError({ message: "A released Ticket Flow worker lifecycle cannot be restarted." }));
		return Effect.sync(() => {
			this.started = true;
			return this;
		});
	}

	shutdown() {
		return Effect.sync(() => {
			if (this.released) return;
			this.released = true;
			this.started = false;
		});
	}

	get isStarted(): boolean {
		return this.started;
	}

	get isReleased(): boolean {
		return this.released;
	}
}

export function prepareWorkerLifecycle(environment: NodeJS.ProcessEnv = process.env) {
	return Effect.try({
		try: () => new WorkerLifecycle(readWorkerEnvironment(environment)),
		catch: (cause) => cause instanceof WorkerEnvironmentError
			? cause
			: new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_ROLE", message: cause instanceof Error ? cause.message : String(cause) }),
	});
}

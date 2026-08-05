import path from "node:path";
import { Data, Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type AuthoritativeWorkerContext, type PiLaunchProfile, type WorkerFeedback, type WorkerReport } from "../domain.ts";
import { workerIdentityFromContext, WorkerProtocolRuntime } from "../protocol/runtime.ts";
import { WorkerContextRuntime } from "./context.ts";
import { type ReportValidationResult, WorkerReportRuntime } from "./report.ts";

export interface WorkerStartupEnvironment {
	readonly runId: string;
	readonly workItemId: string;
	readonly requestedProfile: PiLaunchProfile;
	/** Launch metadata, when supplied by the owner launcher. */
	readonly kind?: "implementation" | "audit" | "fix";
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
	const kind = environment.MEPIE_WORKFLOW_WORKER_KIND;
	if (kind !== undefined && kind !== "implementation" && kind !== "audit" && kind !== "fix") {
		throw new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_WORKER_KIND", message: "MEPIE_WORKFLOW_WORKER_KIND must be implementation, audit, or fix." });
	}
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
		...(kind === undefined ? {} : { kind }),
		socketPath,
		token,
	};
}

export class WorkerLifecycle {
	private started = false;
	private released = false;
	private readonly runtime = new WorkerProtocolRuntime();
	private contextRuntime: WorkerContextRuntime | undefined;
	private reportRuntime: WorkerReportRuntime | undefined;

	constructor(readonly environment: WorkerStartupEnvironment) {}

	start(pi?: ExtensionAPI, context?: ExtensionContext): Effect.Effect<this, WorkerLifecycleError> {
		if (this.released) return Effect.fail(new WorkerLifecycleError({ message: "A released Ticket Flow worker lifecycle cannot be restarted." }));
		const configured = Effect.try({
			try: () => pi && context
				? workerIdentityFromContext(context, this.environment.runId, this.environment.workItemId)
				: undefined,
			catch: (cause) => new WorkerLifecycleError({ message: cause instanceof Error ? cause.message : String(cause) }),
		});
		return configured.pipe(
			Effect.flatMap((identity) => identity && pi && context
				? this.runtime.start({
					socketPath: this.environment.socketPath,
					identity,
					token: this.environment.token,
					onDelegate: (prompt) => pi.sendUserMessage(prompt, context.isIdle() ? undefined : { deliverAs: "followUp" }),
					onFeedback: (message) => pi.sendUserMessage(message, context.isIdle() ? undefined : { deliverAs: "followUp" }),
					onShutdown: () => context.shutdown(),
				}).pipe(Effect.tap((client) => Effect.sync(() => {
					this.contextRuntime = new WorkerContextRuntime(client);
					this.reportRuntime = new WorkerReportRuntime(client);
				})))
				: Effect.void),
			Effect.as(this),
			Effect.tap(() => Effect.sync(() => { this.started = true; })),
		);
	}

	shutdown(): Effect.Effect<void> {
		return this.runtime.shutdown().pipe(Effect.ensuring(Effect.sync(() => {
			this.contextRuntime = undefined;
			this.reportRuntime = undefined;
			this.released = true;
			this.started = false;
		})));
	}

	getContext(): AuthoritativeWorkerContext {
		if (!this.contextRuntime) throw new WorkerLifecycleError({ message: "Worker native protocol has not started." });
		return this.contextRuntime.get();
	}

	waitForFeedback(signal?: AbortSignal, timeoutMs?: number): Promise<WorkerFeedback> {
		if (!this.contextRuntime) return Promise.reject(new WorkerLifecycleError({ message: "Worker native protocol has not started." }));
		return this.contextRuntime.waitForFeedback(signal, timeoutMs);
	}

	submitReport(report: WorkerReport, signal?: AbortSignal): Promise<ReportValidationResult> {
		if (!this.reportRuntime) return Promise.reject(new WorkerLifecycleError({ message: "Worker native protocol has not started." }));
		return this.reportRuntime.submit(report, this.getContext(), signal);
	}

	/** Send a blocking worker question without dropping the authenticated socket. */
	async sendQuestion(message: string, questions: readonly string[] = [message], signal?: AbortSignal, timeoutMs?: number): Promise<WorkerFeedback> {
		const text = message.trim();
		if (!text) throw new WorkerLifecycleError({ message: "Worker question must be non-empty." });
		const normalizedQuestions = questions.map((question) => question.trim()).filter(Boolean);
		if (normalizedQuestions.length === 0) throw new WorkerLifecycleError({ message: "Worker question list must be non-empty." });
		const startedAt = Date.now();
		const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
		const waitSignal = timeoutSignal === undefined
			? signal
			: signal === undefined
				? timeoutSignal
				: AbortSignal.any([signal, timeoutSignal]);
		await this.submitReport({
			status: "blocked",
			summary: text,
			blockers: [text],
			questions: normalizedQuestions,
			userInterventionRequired: false,
		}, waitSignal);
		const remaining = timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
		return this.waitForFeedback(waitSignal, remaining);
	}

	get isStarted(): boolean { return this.started; }
	get isReleased(): boolean { return this.released; }
}

export function prepareWorkerLifecycle(environment: NodeJS.ProcessEnv = process.env) {
	return Effect.try({
		try: () => new WorkerLifecycle(readWorkerEnvironment(environment)),
		catch: (cause) => cause instanceof WorkerEnvironmentError
			? cause
			: new WorkerEnvironmentError({ variable: "MEPIE_WORKFLOW_ROLE", message: cause instanceof Error ? cause.message : String(cause) }),
	});
}

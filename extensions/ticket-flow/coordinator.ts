import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Effect, Semaphore } from "effect";
import type {
	Assignment,
	AuditRound,
	DeliveryRecord,
	OperationCheckpoint,
	ReportReference,
	StoredReport,
	TicketflowRun,
	WorkerIdentity,
	WorkerReport,
	WorkerState,
} from "./model.ts";
import { exactModelParts, isTerminalPhase, TICKETFLOW_VERSION } from "./model.ts";
import type { WorkerBackend } from "./backends/backend.ts";
import { TmuxWorkerBackend } from "./backends/tmux.ts";
import type { GitRunner } from "./git.ts";
import { assertAttemptReady, assertExactAuditScope, gitPreflight, nodeGitRunner, verifyWorkerCommits } from "./git.ts";
import {
	acquireProjectLock,
	assertNoLegacyRun,
	discoverRuns,
	findLatestReport,
	loadRun,
	readStoredReport,
	readTransportToken,
	removeTransportToken,
	resolvePaths,
	saveRun,
	writeReport,
	writeTransportToken,
	type ProjectLock,
	type TicketflowPaths,
} from "./store.ts";
import {
	attachWorker,
	cancelRun,
	closeAudit,
	closeFix,
	closeImplementation,
	failTicket,
	installAssignment,
	interruptAmbiguousDelivery,
	interruptAssignment,
	markDelivery,
	pauseRun,
	recordReport,
	recordSettlement,
	resumeInterrupted,
	resumeRun,
	sameFindingsWithoutNewCommits,
	verifyWorker,
} from "./reducer.ts";
import { AUDIT_PROMPT_TEMPLATE, buildAuditPrompt, buildFixPrompt, findingsHash, validateAuditReport, verifyAuditEvidence } from "./audit.ts";
import { isTicketComplete, sha256 } from "./tickets.ts";
import { PermanentTransportEventError, TransportServer, type TransportIdentity, type TransportReportEvent, type TransportSettledEvent } from "./transport.ts";

export interface CoordinatorOptions {
	readonly backend?: WorkerBackend;
	readonly gitRunner?: GitRunner;
	readonly agentDir?: string;
	readonly now?: () => Date;
	readonly newId?: () => string;
	readonly onChange?: (run: TicketflowRun) => void;
}

export interface CreateRunInput {
	readonly projectPath: string;
	readonly orchestratorSessionId: string;
	readonly setup: TicketflowRun["setup"];
	readonly tickets: TicketflowRun["tickets"];
}

export interface DelegateResult {
	readonly workerId: string;
	readonly assignmentKind: Assignment["kind"];
	readonly handle: WorkerState["handle"];
	readonly model: string;
	readonly thinking: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly initialTask: string;
	readonly promptHash: string;
}

export interface WaitResult {
	readonly workerId: string;
	readonly turn: number;
	readonly status: "reported" | "unreported";
	readonly report?: WorkerReport;
	readonly reportReference?: ReportReference;
	readonly worker: WorkerIdentity;
}

interface ActiveRun {
	run: TicketflowRun;
	readonly paths: TicketflowPaths;
	lock?: ProjectLock;
	transport?: TransportServer;
}

type RunChanges = { [Key in keyof TicketflowRun]?: TicketflowRun[Key] | undefined };

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function patched(run: TicketflowRun, changes: RunChanges, now: string): TicketflowRun {
	const next = { ...run, ...changes, revision: run.revision + 1, updatedAt: now } as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
	return next as unknown as TicketflowRun;
}

function sameIdentity(left: WorkerIdentity, right: WorkerIdentity): boolean {
	return left.sessionId === right.sessionId
		&& left.sessionFile === right.sessionFile
		&& left.provider === right.provider
		&& left.model === right.model
		&& left.thinking === right.thinking;
}

async function materializedIdentity(identity: WorkerIdentity): Promise<WorkerIdentity> {
	try {
		const metadata = await stat(identity.sessionFile);
		if (!metadata.isFile()) return { ...identity, sessionMaterialized: false };
		const firstLine = (await readFile(identity.sessionFile, "utf8")).split("\n", 1)[0];
		const header = firstLine ? JSON.parse(firstLine) as { readonly id?: unknown } : undefined;
		return { ...identity, ...(typeof header?.id === "string" && header.id ? { sessionId: header.id } : {}), sessionMaterialized: true };
	} catch { return { ...identity, sessionMaterialized: false }; }
}

function assignmentDisplayTitle(run: TicketflowRun, assignment: Assignment): string {
	if (assignment.kind === "implementation") return `Ticket Flow · ${run.tickets[assignment.ticketIndex!]?.name ?? assignment.title}`;
	if (assignment.kind === "audit") return `Ticket Flow · audit ${assignment.auditRound}`;
	return `Ticket Flow · fixer ${assignment.auditRound}`;
}

function timeoutSignal(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
	const timeout = AbortSignal.timeout(milliseconds);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export class TicketflowCoordinator {
	private readonly backend: WorkerBackend;
	private readonly gitRunner: GitRunner;
	private readonly agentDir: string | undefined;
	private readonly now: () => Date;
	private readonly newId: () => string;
	private onChange: ((run: TicketflowRun) => void) | undefined;
	private readonly permit = Semaphore.makeUnsafe(1);
	private active: ActiveRun | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();
	private persistenceQueue: Promise<void> = Promise.resolve();

	constructor(options: CoordinatorOptions = {}) {
		this.backend = options.backend ?? new TmuxWorkerBackend();
		this.gitRunner = options.gitRunner ?? nodeGitRunner;
		this.agentDir = options.agentDir;
		this.now = options.now ?? (() => new Date());
		this.newId = options.newId ?? (() => crypto.randomUUID());
		this.onChange = options.onChange;
	}

	setChangeListener(listener: ((run: TicketflowRun) => void) | undefined): void { this.onChange = listener; }

	get activeRun(): TicketflowRun | undefined { return this.active?.run; }

	private timestamp(): string { return this.now().toISOString(); }

	private operation<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, Error> {
		return this.permit.withPermits(1)(Effect.tryPromise({ try: run, catch: errorFrom }));
	}

	private enqueueMutation<A>(operation: () => Promise<A>): Promise<A> {
		const task = this.mutationQueue.then(operation, operation);
		this.mutationQueue = task.then(() => undefined, () => undefined);
		return task;
	}

	private requireActive(): ActiveRun {
		if (!this.active) throw new Error("No active Ticket Flow run.");
		return this.active;
	}

	private async persist(next: TicketflowRun, signal?: AbortSignal): Promise<TicketflowRun> {
		const active = this.requireActive();
		if (next === active.run) return next;
		const expectedRevision = active.run.revision;
		const task = this.persistenceQueue.then(async () => {
			if (this.requireActive() !== active || active.run.revision !== expectedRevision) throw new Error("Stale Ticket Flow state mutation was fenced by a newer durable revision.");
			const durable = await loadRun(active.paths);
			if (durable.revision !== expectedRevision) throw new Error("Ticket Flow run.json revision changed outside the coordinator actor.");
			await saveRun(active.paths, next, signal);
			active.run = next;
			try { this.onChange?.(next); } catch { /* UI listeners never invalidate durable state. */ }
		});
		this.persistenceQueue = task.then(() => undefined, () => undefined);
		await task;
		return next;
	}

	private async mutate(change: (run: TicketflowRun) => TicketflowRun): Promise<TicketflowRun> {
		return this.enqueueMutation(async () => this.persist(change(this.requireActive().run)));
	}

	verifyBackend(): Effect.Effect<void, Error> {
		return this.operation((signal) => this.backend.validate(signal));
	}

	createRun(input: CreateRunInput): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (signal) => {
			if (this.active && isTerminalPhase(this.active.run.phase)) await this.shutdownRuntime();
			if (this.active) throw new Error(`Ticket Flow run ${this.active.run.id} is already active.`);
			if (!input.orchestratorSessionId.trim()) throw new Error("Ticket Flow requires a persistent Main Pi session ID.");
			await this.backend.validate(signal);
			await assertNoLegacyRun(input.projectPath, this.agentDir);
			const unfinished = await discoverRuns(input.projectPath, this.agentDir);
			if (unfinished.length > 0) throw new Error(`Unfinished Ticket Flow run ${unfinished[0]!.run.id} exists; use /ticketflow resume or stop.`);
			const id = this.newId();
			const paths = await resolvePaths(input.projectPath, id, this.agentDir);
			const lock = await acquireProjectLock(paths, id, input.orchestratorSessionId);
			try {
				const git = await gitPreflight(paths.projectPath, this.gitRunner, signal);
				const timestamp = this.timestamp();
				const run: TicketflowRun = {
					version: TICKETFLOW_VERSION,
					revision: 0,
					id,
					projectId: paths.projectId,
					projectPath: paths.projectPath,
					backend: "tmux",
					orchestratorSessionId: input.orchestratorSessionId,
					phase: "implementation",
					setup: input.setup,
					tickets: input.tickets,
					currentTicket: 0,
					git,
					auditRounds: [],
					findings: [],
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				this.active = { run, paths, lock };
				await saveRun(paths, run, signal);
				return run;
			} catch (cause) {
				await lock.release();
				this.active = undefined;
				throw cause;
			}
		});
	}

	recover(projectPath: string, orchestratorSessionId: string): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (signal) => {
			if (this.active) return this.active.run;
			const runs = await discoverRuns(projectPath, this.agentDir);
			if (runs.length === 0) throw new Error("No unfinished Ticket Flow run exists for this project.");
			if (runs.length > 1) throw new Error("Multiple unfinished Ticket Flow runs exist; manual state cleanup is required.");
			const candidate = runs[0]!;
			const lock = await acquireProjectLock(candidate.paths, candidate.run.id, orchestratorSessionId, candidate.run.orchestratorSessionId);
			const run = patched(candidate.run, { orchestratorSessionId }, this.timestamp());
			this.active = { run, paths: candidate.paths, lock };
			try {
				await saveRun(candidate.paths, run, signal);
				if (run.assignment) await this.ensureTransport();
				return run;
			} catch (cause) {
				await this.shutdownRuntime();
				throw cause;
			}
		});
	}

	private async checkpoint(checkpoint: OperationCheckpoint): Promise<TicketflowRun> {
		return this.mutate((run) => patched(run, { checkpoint }, checkpoint.updatedAt));
	}

	private socketPath(runId: string, assignmentId: string): string {
		const digest = createHash("sha256").update(`${runId}:${assignmentId}`).digest("hex").slice(0, 24);
		return path.join(os.tmpdir(), `ticketflow-${process.getuid?.() ?? "user"}`, digest, "bridge.sock");
	}

	private async ensureTransport(): Promise<TransportServer> {
		const active = this.requireActive();
		const assignment = active.run.assignment;
		if (!assignment) throw new Error("A worker transport requires an active assignment.");
		if (active.transport?.options.assignmentId === assignment.id) return active.transport;
		if (active.transport) await active.transport.close();
		let token: string;
		try { token = await readTransportToken(active.paths); }
		catch {
			token = crypto.randomUUID();
			await writeTransportToken(active.paths, token);
		}
		const server = new TransportServer({
			socketPath: this.socketPath(active.run.id, assignment.id),
			runId: active.run.id,
			assignmentId: assignment.id,
			token,
			requestedProfile: active.run.setup.workerProfile,
			onReady: (identity) => this.onWorkerReady(assignment.id, identity),
			onReport: (event) => this.onWorkerReport(assignment.id, event),
			onSettled: (event) => this.onWorkerSettled(assignment.id, event),
		});
		await server.start();
		active.transport = server;
		return server;
	}

	private async onWorkerReady(assignmentId: string, identity: TransportIdentity): Promise<void> {
		// Pi can authenticate before tmux spawn returns its stable handle. Buffer
		// readiness until that handle is durably attached instead of rejecting a
		// valid fast Worker and making its bridge terminally stop.
		const deadline = Date.now() + 30_000;
		while (this.active?.run.assignment?.id === assignmentId && !this.active.run.worker && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await this.enqueueMutation(async () => {
			const active = this.requireActive();
			const run = active.run;
			if (run.assignment?.id !== assignmentId || !run.worker) throw new Error("Worker readiness does not match the active durable assignment.");
			let workerIdentity: WorkerIdentity = await materializedIdentity(identity);
			if (run.worker.identity) {
				const expected = run.worker.identity;
				const sameProfileAndFile = expected.sessionFile === workerIdentity.sessionFile && expected.provider === workerIdentity.provider && expected.model === workerIdentity.model && expected.thinking === workerIdentity.thinking;
				if (!sameProfileAndFile || (expected.sessionMaterialized !== false && expected.sessionId !== workerIdentity.sessionId)) throw new Error(`Resumed worker identity/profile mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(workerIdentity)}.`);
				if (expected.sessionMaterialized === false) workerIdentity = { ...workerIdentity, sessionId: expected.sessionId, sessionMaterialized: false };
			}
			const next = verifyWorker(run, workerIdentity, this.timestamp());
			await this.persist(next);
		});
	}

	private async onWorkerReport(assignmentId: string, event: TransportReportEvent): Promise<void> {
		await this.enqueueMutation(async () => {
			const active = this.requireActive();
			let run = active.run;
			const assignment = run.assignment;
			const identity = run.worker?.identity;
			if (!assignment || assignment.id !== assignmentId || !identity || (assignment.turn !== event.turn && !(run.checkpoint?.step === "send" && assignment.turn + 1 === event.turn))) throw new PermanentTransportEventError("Worker report identity/turn does not match the active assignment.");
			const report = event.report as WorkerReport;
			if (assignment.kind !== "audit" && report.status === "audit") throw new PermanentTransportEventError(`Report status ${report.status} is invalid for a ${assignment.kind} assignment.`);
			if (report.status === "blocked" && report.questions.length === 0) throw new PermanentTransportEventError("A blocked report requires at least one question.");
			if (assignment.turn !== event.turn) {
				const checkpoint = run.checkpoint!;
				run = markDelivery(run, {
					requestId: checkpoint.requestId!, delivery: checkpoint.delivery!, messageHash: checkpoint.messageHash!,
				}, this.timestamp());
			}
			if (run.report?.turn === event.turn) {
				const existing = await readStoredReport(run.report.path, run.report.hash, active.paths.reportsDir);
				if (JSON.stringify(existing.report) === JSON.stringify(report)) return;
				throw new PermanentTransportEventError("A different immutable report already exists for this assignment turn.");
			}
			const submittedAt = this.timestamp();
			const stored: StoredReport = { version: 1, runId: run.id, assignmentId, worker: identity, turn: event.turn, report, submittedAt };
			const written = await writeReport(active.paths, stored);
			const reference: ReportReference = { id: event.eventId, assignmentId, turn: event.turn, status: report.status, path: written.path, hash: written.hash, createdAt: submittedAt };
			try { run = recordReport(run, reference, submittedAt); }
			catch (cause) { throw new PermanentTransportEventError(cause instanceof Error ? cause.message : String(cause)); }
			if (assignment.kind === "implementation" && (report.status === "blocked" || report.status === "failed")) {
				const status = report.status === "blocked" ? "blocked" : "failed";
				run = patched(run, { tickets: run.tickets.map((ticket, index) => index === run.currentTicket ? { ...ticket, status } : ticket) }, submittedAt);
			}
			if (report.status === "failed") run = assignment.kind === "implementation"
				? failTicket(run, report.summary, submittedAt)
				: pauseRun(run, "worker-failed", report.summary, submittedAt);
			await this.persist(run);
		});
	}

	private async onWorkerSettled(assignmentId: string, event: TransportSettledEvent): Promise<void> {
		await this.enqueueMutation(async () => {
			const active = this.requireActive();
			const run = active.run;
			if (run.assignment?.id !== assignmentId) throw new PermanentTransportEventError("Worker settlement does not match the active assignment.");
			let settledRun = run;
			if (run.assignment.turn !== event.turn && run.checkpoint?.step === "send" && run.assignment.turn + 1 === event.turn) {
				settledRun = markDelivery(run, { requestId: run.checkpoint.requestId!, delivery: run.checkpoint.delivery!, messageHash: run.checkpoint.messageHash! }, this.timestamp());
			}
			let next: TicketflowRun;
			try { next = recordSettlement(settledRun, event.turn, this.timestamp()); }
			catch (cause) { throw new PermanentTransportEventError(cause instanceof Error ? cause.message : String(cause)); }
			await this.persist(next);
		});
	}

	private async createAssignment(run: TicketflowRun): Promise<{ readonly run: TicketflowRun; readonly assignment: Assignment }> {
		const timestamp = this.timestamp();
		const attemptBaseCommit = await assertAttemptReady(run.projectPath, run.git, this.gitRunner);
		let assignment: Assignment;
		if (run.phase === "implementation") {
			const ticket = run.tickets[run.currentTicket];
			if (!ticket) throw new Error("No queued implementation ticket remains.");
			const substitutions = {
				"{ticketPath}": ticket.path,
				"{ticketName}": ticket.name,
				"{ticketIndex}": String(ticket.index + 1),
				"{ticketCount}": String(run.tickets.length),
				"{referencePaths}": run.setup.referencePaths.join("\n"),
			};
			assignment = {
				id: `implementation-${ticket.order}-${this.newId()}`,
				kind: "implementation",
				title: ticket.name,
				prompt: ticket.delegationPrompt,
				promptHash: sha256(ticket.delegationPrompt),
				promptSubstitutions: substitutions,
				ticketIndex: ticket.index,
				attemptBaseCommit,
				stage: "launching",
				turn: 0,
				createdAt: timestamp,
			};
		} else if (run.phase === "audit") {
			await assertExactAuditScope({ cwd: run.projectPath, state: run.git, acceptedCommitIds: run.git.acceptedCommitIds, acceptedHead: run.git.acceptedHead, runner: this.gitRunner });
			const round = Math.max(0, ...run.auditRounds.map((candidate) => candidate.round)) + 1;
			const audit = buildAuditPrompt({
				featureOrCommits: run.git.acceptedCommitIds.join(" "),
				ticketsAndReferences: [run.setup.ticketsDirectory, ...run.setup.referencePaths].join(", "),
			});
			assignment = {
				id: `audit-${round}-${this.newId()}`,
				kind: "audit",
				title: `Audit round ${round}`,
				prompt: audit.prompt,
				promptHash: audit.hash,
				promptSubstitutions: audit.substitutions,
				auditRound: round,
				auditCommitIds: [...run.git.acceptedCommitIds],
				auditRequirements: [...new Set(run.tickets.flatMap((ticket) => ticket.requirements ?? []))],
				attemptBaseCommit,
				stage: "launching",
				turn: 0,
				createdAt: timestamp,
			};
			const pendingRound: AuditRound = {
				round,
				assignmentId: assignment.id,
				template: AUDIT_PROMPT_TEMPLATE,
				prompt: audit.prompt,
				promptHash: audit.hash,
				substitutions: audit.substitutions,
				acceptedCommitIds: [...run.git.acceptedCommitIds],
				acceptedHead: run.git.acceptedHead,
				status: "pending",
				findings: [],
				createdAt: timestamp,
			};
			run = patched(run, { auditRounds: [...run.auditRounds, pendingRound] }, timestamp);
		} else if (run.phase === "fix") {
			const round = run.auditRounds.at(-1);
			if (!round || round.status !== "findings" || run.findings.length === 0) throw new Error("Fix phase has no durable audit findings.");
			const prompt = buildFixPrompt(run.findings, round.acceptedCommitIds);
			assignment = {
				id: `fix-${round.round}-${this.newId()}`,
				kind: "fix",
				title: `Fix audit round ${round.round}`,
				prompt,
				promptHash: sha256(prompt),
				promptSubstitutions: { findingIds: run.findings.map((finding) => finding.id).join(" "), auditedCommitIds: round.acceptedCommitIds.join(" ") },
				auditRound: round.round,
				findingIds: run.findings.map((finding) => finding.id),
				attemptBaseCommit,
				stage: "launching",
				turn: 0,
				createdAt: timestamp,
			};
		} else throw new Error(`Cannot create an assignment while run is ${run.phase}.`);
		return { run: installAssignment(run, assignment, timestamp), assignment };
	}

	delegate(): Effect.Effect<DelegateResult, Error> {
		return this.operation(async (signal) => {
			let active = this.requireActive();
			let run = active.run;
			if (run.phase === "paused") throw new Error(run.pause?.message ?? "Ticket Flow is paused.");
			if (isTerminalPhase(run.phase)) throw new Error(`Ticket Flow is ${run.phase}.`);
			let assignment = run.assignment;
			if (assignment && run.worker) throw new Error("The active assignment already owns a worker.");
			if (!assignment) {
				const created = await this.createAssignment(run);
				run = created.run;
				assignment = created.assignment;
				const operationId = this.newId();
				const backendIdentity = await this.backend.identify?.(signal);
				run = patched(run, { checkpoint: { operationId, step: "launch", assignmentId: assignment.id, ...(backendIdentity === undefined ? {} : { backendIdentity }), updatedAt: this.timestamp() } }, this.timestamp());
				await this.persist(run, signal);
			}
			const checkpoint = run.checkpoint;
			const operationId = checkpoint?.step === "launch" && checkpoint.assignmentId === assignment.id ? checkpoint.operationId : this.newId();
			if (!checkpoint || checkpoint.operationId !== operationId) {
				const backendIdentity = await this.backend.identify?.(signal);
				await this.checkpoint({ operationId, step: "launch", assignmentId: assignment.id, ...(backendIdentity === undefined ? {} : { backendIdentity }), updatedAt: this.timestamp() });
			}
			active = this.requireActive();
			const transport = await this.ensureTransport();
			const token = await readTransportToken(active.paths);
			const handle = await this.backend.spawn({
				cwd: active.run.projectPath,
				runId: active.run.id,
				assignmentId: assignment.id,
				operationId,
				title: assignmentDisplayTitle(active.run, assignment),
				profile: active.run.setup.workerProfile,
				kind: assignment.kind,
				socketPath: transport.options.socketPath,
				token,
				...(this.requireActive().run.checkpoint?.backendIdentity === undefined ? {} : { backendIdentity: this.requireActive().run.checkpoint!.backendIdentity }),
			}, signal);
			await this.mutate((current) => {
				if (current.assignment?.id !== assignment!.id) throw new Error("Assignment changed while launching its worker.");
				const worker: WorkerState = { id: this.newId(), handle, requestedProfile: current.setup.workerProfile };
				const attached = attachWorker(current, worker, this.timestamp());
				return patched(attached, { checkpoint: { operationId, step: "authenticate", assignmentId: assignment!.id, updatedAt: this.timestamp() } }, this.timestamp());
			});
			const identity = await transport.waitReady(timeoutSignal(signal, 30_000));
			const current = this.requireActive().run;
			if (!current.worker?.identity || !sameIdentity(current.worker.identity, identity)) throw new Error("Worker readiness was not durably verified.");
			return {
				workerId: current.worker.id,
				assignmentKind: assignment.kind,
				handle: current.worker.handle,
				model: current.setup.workerProfile.model,
				thinking: current.setup.workerProfile.thinking,
				sessionId: identity.sessionId,
				sessionFile: identity.sessionFile,
				initialTask: assignment.prompt,
				promptHash: assignment.promptHash,
			};
		});
	}

	send(input: { readonly workerId: string; readonly delivery: "task" | "steer" | "follow-up"; readonly message: string }): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (signal) => {
			const active = this.requireActive();
			const run = active.run;
			const assignment = run.assignment;
			if (run.phase === "paused") throw new Error("Ticket Flow is paused; resume progression before sending a new worker turn.");
			if (!assignment || run.worker?.id !== input.workerId || !run.worker.identity) throw new Error("ticketflow_send workerId does not own the active verified worker.");
			if (!input.message || input.message.includes("\0")) throw new Error("ticketflow_send requires a non-empty control-safe message.");
			if (Buffer.byteLength(input.message, "utf8") > 30 * 1024 || input.message.split("\n").length > 1_500) throw new Error("ticketflow_send message exceeds Ticket Flow transport bounds.");
			if (input.delivery === "task" && input.message !== assignment.prompt) throw new Error("The initial task must be the exact substituted delegation/audit/fix prompt with no prefix or suffix.");
			if (input.delivery !== "task" && assignment.turn === 0) throw new Error("Send the initial task before steering or follow-up work.");
			const messageHash = sha256(input.message);
			if (assignment.lastDelivery?.delivery === input.delivery && assignment.lastDelivery.messageHash === messageHash && assignment.stage === "running") return run;
			// Decide transition legality before any transport side effect. A command
			// rejected here can never create an unrecorded Worker turn.
			markDelivery(run, { requestId: "preflight", delivery: input.delivery, messageHash }, this.timestamp());
			const pending = run.checkpoint?.step === "send" && run.checkpoint.assignmentId === assignment.id
				&& run.checkpoint.delivery === input.delivery && run.checkpoint.messageHash === messageHash
				? run.checkpoint
				: undefined;
			const requestId = pending?.requestId ?? this.newId();
			const operationId = pending?.operationId ?? this.newId();
			if (!pending) await this.checkpoint({ operationId, step: "send", assignmentId: assignment.id, requestId, delivery: input.delivery, messageHash, updatedAt: this.timestamp() });
			const transport = await this.ensureTransport();
			const turn = assignment.turn + 1;
			try {
				if (input.delivery === "task") await transport.send({ command: "task", message: input.message, turn, requestId }, signal);
				else await transport.send({ command: input.delivery, message: input.message, turn, requestId }, signal);
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				if (/delivery outcome is ambiguous after process recovery/i.test(message)) {
					await this.mutate((current) => interruptAmbiguousDelivery(current, { requestId, delivery: input.delivery, messageHash }, this.timestamp()));
					await this.mutate((current) => pauseRun(current, "recovery", "Worker command delivery was ambiguous after process recovery. Inspect the persisted Pi session, resume Ticket Flow, then send explicit follow-up work; the old command will never be replayed.", this.timestamp()));
				}
				throw cause;
			}
			let next = await this.mutate((current) => current.assignment?.lastDelivery?.requestId === requestId
				? current
				: markDelivery(current, { requestId, delivery: input.delivery, messageHash }, this.timestamp()));
			if (next.worker?.identity && next.worker.identity.sessionMaterialized !== true) {
				const identity = await materializedIdentity(next.worker.identity);
				if (identity.sessionMaterialized) next = await this.mutate((current) => patched(current, { worker: { ...current.worker!, identity } }, this.timestamp()));
			}
			if (next.assignment?.kind === "implementation") {
				next = await this.mutate((current) => patched(current, { tickets: current.tickets.map((ticket, index) => index === current.currentTicket ? { ...ticket, status: "running" as const } : ticket) }, this.timestamp()));
			}
			return next;
		});
	}

	private async reconcileReportReference(): Promise<void> {
		const active = this.requireActive();
		const run = active.run;
		if (run.report || !run.assignment || run.assignment.turn < 1) return;
		const latest = await findLatestReport(active.paths, run.assignment.id, run.assignment.turn);
		if (!latest) return;
		const reference: ReportReference = {
			id: latest.hash.slice(0, 32), assignmentId: run.assignment.id, turn: run.assignment.turn,
			status: latest.stored.report.status, path: latest.path, hash: latest.hash, createdAt: latest.stored.submittedAt,
		};
		await this.mutate((current) => recordReport(current, reference, this.timestamp()));
	}

	private async waitResult(workerId: string): Promise<WaitResult> {
		await this.reconcileReportReference();
		const run = this.requireActive().run;
		const assignment = run.assignment;
		const worker = run.worker;
		if (!assignment || !worker?.identity || worker.id !== workerId) throw new Error("Worker is no longer active.");
		if (worker.lastSettledTurn !== assignment.turn || assignment.stage !== "settled") throw new Error("Worker has not durably reached agent_settled for this turn.");
		if (!run.report || run.report.turn !== assignment.turn) return { workerId, turn: assignment.turn, status: "unreported", worker: worker.identity };
		const stored = await readStoredReport(run.report.path, run.report.hash, this.requireActive().paths.reportsDir);
		return { workerId, turn: assignment.turn, status: "reported", report: stored.report, reportReference: run.report, worker: worker.identity };
	}

	wait(workerId: string): Effect.Effect<WaitResult, Error> {
		return this.operation(async (signal) => {
			await this.reconcileReportReference();
			const run = this.requireActive().run;
			const assignment = run.assignment;
			const worker = run.worker;
			if (!assignment || worker?.id !== workerId || !worker.identity || assignment.turn < 1) throw new Error("ticketflow_wait requires an active worker turn.");
			if (assignment.stage !== "settled" || worker.lastSettledTurn !== assignment.turn) {
				const transport = await this.ensureTransport();
				// Cancelling this wait removes only its transport waiter. It never sends
				// abort and never touches the worker backend.
				await transport.waitForSettlement(assignment.turn, signal);
			}
			return this.waitResult(workerId);
		});
	}

	private async assertReportGate(run: TicketflowRun): Promise<{ readonly assignment: Assignment; readonly worker: WorkerState & { readonly identity: WorkerIdentity }; readonly reference: ReportReference; readonly report: WorkerReport }> {
		const assignment = run.assignment;
		const worker = run.worker;
		const reference = run.report;
		if (!assignment || !worker?.identity || !reference) throw new Error("Close requires an active worker and durable report.");
		if (assignment.stage !== "settled" || worker.lastSettledTurn !== assignment.turn || reference.turn !== assignment.turn) throw new Error("Report, agent_settled, and close are separate facts; the active turn has not satisfied both prerequisites.");
		const stored = await readStoredReport(reference.path, reference.hash, this.requireActive().paths.reportsDir);
		if (stored.runId !== run.id || stored.assignmentId !== assignment.id || stored.turn !== assignment.turn || !sameIdentity(stored.worker, worker.identity)) throw new Error("Immutable report identity does not match the active worker turn.");
		return { assignment, worker: worker as WorkerState & { readonly identity: WorkerIdentity }, reference, report: stored.report };
	}

	private async closeOwnedWorker(run: TicketflowRun, signal?: AbortSignal): Promise<void> {
		const active = this.requireActive();
		if (!run.worker) throw new Error("No owned worker exists to close.");
		const transport = active.transport;
		if (transport?.isReady) {
			const turn = run.assignment?.turn;
			await transport.send({ command: "shutdown", ...(turn === undefined ? {} : { turn }) }, timeoutSignal(signal, 2_000)).catch(() => undefined);
		}
		await this.backend.close(run.worker.handle, signal);
		await transport?.close();
		delete active.transport;
		await removeTransportToken(active.paths);
	}

	close(workerId: string): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (signal) => {
			let run = this.requireActive().run;
			if (!run.worker && run.lastClosed?.workerId === workerId) return run;
			if (run.phase === "paused") throw new Error("Resume Ticket Flow before advancing the cursor.");
			if (run.worker?.id !== workerId) throw new Error("ticketflow_close workerId does not own the active worker.");
			if (run.assignment?.stage === "interrupted" || run.checkpoint?.step === "abort") throw new Error("An interrupted/aborting assignment can never be closed as complete; finish abort recovery, resume, and send follow-up work.");
			const gate = await this.assertReportGate(run);
			await this.checkpoint({ operationId: this.newId(), step: "verify", assignmentId: gate.assignment.id, updatedAt: this.timestamp() });
			run = this.requireActive().run;
			if (gate.assignment.kind === "implementation") {
				if (gate.report.status !== "completed") throw new Error(`Implementation cannot close from a ${gate.report.status} report.`);
				const verified = await verifyWorkerCommits({ cwd: run.projectPath, state: run.git, attemptBaseCommit: gate.assignment.attemptBaseCommit, reportedCommitIds: gate.report.commitIds, runner: this.gitRunner, signal });
				const ticket = run.tickets[gate.assignment.ticketIndex!];
				if (!ticket || !await isTicketComplete(ticket.path)) throw new Error("Implementation ticket is not complete under the v1 all-Markdown-checkboxes convention.");
				await this.checkpoint({ operationId: this.newId(), step: "close", assignmentId: gate.assignment.id, updatedAt: this.timestamp() });
				await this.closeOwnedWorker(this.requireActive().run, signal);
				const closedAt = this.timestamp();
				let next = closeImplementation(this.requireActive().run, verified.commitIds, verified.head, closedAt);
				next = patched(next, { lastClosed: { workerId, assignmentId: gate.assignment.id, kind: gate.assignment.kind, closedAt, resultingPhase: next.phase } }, closedAt);
				return this.persist(next, signal);
			}
			if (gate.assignment.kind === "fix") {
				if (gate.report.status !== "completed") throw new Error(`Fixer cannot close from a ${gate.report.status} report.`);
				const verified = await verifyWorkerCommits({ cwd: run.projectPath, state: run.git, attemptBaseCommit: gate.assignment.attemptBaseCommit, reportedCommitIds: gate.report.commitIds, runner: this.gitRunner, signal });
				await this.checkpoint({ operationId: this.newId(), step: "close", assignmentId: gate.assignment.id, updatedAt: this.timestamp() });
				await this.closeOwnedWorker(this.requireActive().run, signal);
				const closedAt = this.timestamp();
				let next = closeFix(this.requireActive().run, verified.commitIds, verified.head, closedAt);
				next = patched(next, { lastClosed: { workerId, assignmentId: gate.assignment.id, kind: gate.assignment.kind, closedAt, resultingPhase: next.phase } }, closedAt);
				return this.persist(next, signal);
			}
			validateAuditReport(gate.report, gate.assignment.auditCommitIds ?? [], gate.assignment.auditRequirements);
			await verifyAuditEvidence(run.projectPath, gate.report);
			await assertExactAuditScope({ cwd: run.projectPath, state: run.git, acceptedCommitIds: gate.report.auditedCommitIds, acceptedHead: run.git.acceptedHead, runner: this.gitRunner, signal });
			const hash = findingsHash(gate.report.findings);
			const pending = run.auditRounds.find((round) => round.assignmentId === gate.assignment.id && round.status === "pending");
			if (!pending) throw new Error("Audit assignment has no durable pending audit round.");
			const completedAt = this.timestamp();
			const round: AuditRound = {
				...pending,
				status: gate.report.findings.length === 0 ? "clean" : "findings",
				report: gate.reference,
				findings: gate.report.findings,
				findingsHash: hash,
				completedAt,
			};
			const noProgress = gate.report.findings.length > 0 && sameFindingsWithoutNewCommits(run, hash);
			await this.checkpoint({ operationId: this.newId(), step: "close", assignmentId: gate.assignment.id, updatedAt: completedAt });
			await this.closeOwnedWorker(this.requireActive().run, signal);
			let next = closeAudit(this.requireActive().run, round, completedAt);
			next = patched(next, { lastClosed: { workerId, assignmentId: gate.assignment.id, kind: gate.assignment.kind, closedAt: completedAt, resultingPhase: next.phase } }, completedAt);
			if (noProgress) next = pauseRun(next, "audit-no-progress", "The same audit findings recurred without a new accepted commit; user intervention is required.", completedAt);
			next = await this.persist(next, signal);
			if (next.phase === "completed") await this.releaseLock();
			return next;
		});
	}

	resumeWorker(workerId: string): Effect.Effect<DelegateResult, Error> {
		return this.operation((signal) => this.resumeWorkerInternal(workerId, signal));
	}

	private async resumeWorkerInternal(workerId: string, signal: AbortSignal): Promise<DelegateResult> {
		const active = this.requireActive();
		let run = active.run;
		const assignment = run.assignment;
		const worker = run.worker;
		if (!assignment || !worker?.identity || worker.id !== workerId) throw new Error("ticketflow_resume requires the exact persisted worker session.");
		if (run.checkpoint?.step === "close") throw new Error("This Worker is in a durable close checkpoint; retry ticketflow_close instead of reopening it.");
		if (run.phase === "paused") throw new Error("Use /ticketflow resume before reopening a paused run worker.");
		const inspection = await this.backend.inspect(worker.handle, signal);
		const transport = await this.ensureTransport();
		let handle = worker.handle;
		if (inspection.state === "foreign" || inspection.state === "ambiguous") throw new Error(inspection.message);
		if (inspection.state === "missing" || inspection.state === "exited") {
			const operationId = worker.handle.operationId;
			await this.checkpoint({ operationId, step: "resume", assignmentId: assignment.id, updatedAt: this.timestamp() });
			const token = await readTransportToken(active.paths);
			handle = await this.backend.reopen({
				cwd: run.projectPath, runId: run.id, assignmentId: assignment.id, operationId,
				title: assignmentDisplayTitle(run, assignment), profile: run.setup.workerProfile,
				kind: assignment.kind, socketPath: transport.options.socketPath, token,
				backendIdentity: { serverSocketPath: worker.handle.serverSocketPath, sessionId: worker.handle.sessionId, sessionName: worker.handle.sessionName },
				sessionFile: worker.identity.sessionFile,
			}, signal);
			await this.mutate((current) => patched(current, { worker: { ...current.worker!, handle } }, this.timestamp()));
		}
		const identity = await transport.waitReady(timeoutSignal(signal, 30_000));
		run = this.requireActive().run;
		const persistedIdentity = run.worker?.identity;
		const provisionalMatch = persistedIdentity?.sessionMaterialized === false && persistedIdentity.sessionFile === identity.sessionFile && persistedIdentity.provider === identity.provider && persistedIdentity.model === identity.model && persistedIdentity.thinking === identity.thinking;
		if (!persistedIdentity || (!sameIdentity(persistedIdentity, identity) && !provisionalMatch)) throw new Error("Resumed Pi worker session/profile does not match persisted identity.");
		if (run.assignment?.stage === "interrupted") run = await this.mutate((current) => resumeInterrupted(current, this.timestamp()));
		return { workerId, assignmentKind: assignment.kind, handle, model: run.setup.workerProfile.model, thinking: run.setup.workerProfile.thinking, sessionId: persistedIdentity.sessionId, sessionFile: persistedIdentity.sessionFile, initialTask: assignment.prompt, promptHash: assignment.promptHash };
	}

	abort(workerId: string): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (_signal) => {
			const run = this.requireActive().run;
			const assignment = run.assignment;
			const worker = run.worker;
			if (!assignment || worker?.id !== workerId || assignment.turn < 1) throw new Error("ticketflow_abort requires an active worker turn.");
			if (run.checkpoint?.step === "abort" && assignment.stage === "settled") return this.mutate((current) => interruptAssignment(current, this.timestamp()));
			if (assignment.stage !== "running") throw new Error("ticketflow_abort requires an actively running worker turn.");
			await this.checkpoint({ operationId: this.newId(), step: "abort", assignmentId: assignment.id, updatedAt: this.timestamp() });
			const transport = await this.ensureTransport();
			const waitSignal = AbortSignal.timeout(5_000);
			try {
				await transport.abort(assignment.turn, waitSignal);
				await transport.waitForSettlement(assignment.turn, waitSignal);
			} catch {
				await this.backend.abort(worker.handle).catch(() => undefined);
				await transport.waitForSettlement(assignment.turn, AbortSignal.timeout(2_000)).catch(() => undefined);
			}
			const settled = this.requireActive().run;
			if (settled.worker?.lastSettledTurn !== assignment.turn || settled.assignment?.stage !== "settled") throw new Error("Worker abort did not reach durable agent_settled; the assignment remains active and resumable.");
			return this.mutate((current) => interruptAssignment(current, this.timestamp()));
		});
	}

	pause(): Effect.Effect<TicketflowRun, Error> {
		return this.operation(() => this.mutate((run) => pauseRun(run, "user", run.assignment?.stage === "running" ? "Pausing after current worker." : "Ticket Flow is paused.", this.timestamp())));
	}

	resumeProgression(): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (signal) => {
			let run = this.requireActive().run;
			if (run.phase === "paused") run = await this.mutate((current) => resumeRun(current, this.timestamp()));
			if (run.worker?.identity && run.checkpoint?.step !== "close") {
				const inspection = await this.backend.inspect(run.worker.handle, signal);
				if (inspection.state === "missing" || inspection.state === "exited") {
					await this.resumeWorkerInternal(run.worker.id, signal);
					run = this.requireActive().run;
				} else if (inspection.state === "foreign" || inspection.state === "ambiguous") {
					run = await this.mutate((current) => pauseRun(current, "recovery", inspection.message, this.timestamp()));
				} else {
					await (await this.ensureTransport()).waitReady(timeoutSignal(signal, 30_000));
					if (run.assignment?.stage === "interrupted") run = await this.mutate((current) => resumeInterrupted(current, this.timestamp()));
				}
			}
			return run;
		});
	}

	stop(): Effect.Effect<TicketflowRun, Error> {
		return this.operation(async (_signal) => {
			let run = this.requireActive().run;
			const assignment = run.assignment;
			const launchOperationId = run.worker?.handle.operationId ?? run.checkpoint?.launchOperationId ?? (run.checkpoint?.step === "launch" ? run.checkpoint.operationId : undefined);
			const launchBackendIdentity = run.worker
				? { serverSocketPath: run.worker.handle.serverSocketPath, sessionId: run.worker.handle.sessionId, sessionName: run.worker.handle.sessionName }
				: run.checkpoint?.backendIdentity;
			if (assignment) await this.checkpoint({ operationId: this.newId(), step: "close", assignmentId: assignment.id, ...(launchOperationId === undefined ? {} : { launchOperationId }), ...(launchBackendIdentity === undefined ? {} : { backendIdentity: launchBackendIdentity }), updatedAt: this.timestamp() });
			run = this.requireActive().run;
			if (run.worker) {
				const transport = this.active?.transport;
				if (run.assignment?.stage === "running" && transport?.isReady) {
					await transport.abort(run.assignment.turn, AbortSignal.timeout(2_000)).catch(() => undefined);
					await transport.waitForSettlement(run.assignment.turn, AbortSignal.timeout(2_000)).catch(() => undefined);
				}
				// Ownership/ambiguity errors are terminal-control failures. Never claim
				// cancellation or release the project lock while a target is unverified.
				await this.backend.close(run.worker.handle);
				await transport?.close();
				if (this.active) delete this.active.transport;
				await removeTransportToken(this.requireActive().paths);
			} else if (assignment && launchOperationId) {
				if (!this.backend.closeLaunchIntent) throw new Error("Backend cannot safely reconcile a crash-created Worker launch intent.");
				await this.backend.closeLaunchIntent({ runId: run.id, assignmentId: assignment.id, operationId: launchOperationId, ...(launchBackendIdentity === undefined ? {} : { backendIdentity: launchBackendIdentity }) });
				await this.active?.transport?.close();
				if (this.active) delete this.active.transport;
				await removeTransportToken(this.requireActive().paths);
			}
			run = cancelRun(this.requireActive().run, this.timestamp());
			await this.persist(run);
			await this.releaseLock();
			return run;
		});
	}

	status(): Effect.Effect<TicketflowRun, Error> {
		return Effect.try({ try: () => this.requireActive().run, catch: errorFrom });
	}

	private async releaseLock(): Promise<void> {
		const active = this.active;
		const lock = active?.lock;
		if (!active || !lock) return;
		delete active.lock;
		await lock.release();
	}

	private async shutdownRuntime(): Promise<void> {
		const active = this.active;
		if (!active) return;
		await active.transport?.close().catch(() => undefined);
		delete active.transport;
		await this.releaseLock();
		this.active = undefined;
	}

	shutdown(): Effect.Effect<void, Error> {
		return this.operation(() => this.shutdownRuntime());
	}
}

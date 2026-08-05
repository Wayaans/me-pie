import { createHash } from "node:crypto";
import { Effect } from "effect";
import type {
	AuditFinding,
	AuditRequirementVerdict,
	AuditRound,
	AuditRunState,
	PiLaunchProfile,
	WorkerReport,
	WorkflowPlan,
	WorkflowRun,
	WorkItem,
} from "./domain.ts";
import { acceptedCommitRange, assertGitReadyForAudit, type GitCommandRunner } from "./git.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { transitionRun, validatePlan } from "./state-machine.ts";

/** Immutable user-approved audit prompt. Do not add a prefix or suffix. */
export const AUDIT_PROMPT_TEMPLATE = "Audit the implementation of {name feature} in git commit {git id for all the commit when implementing} against the implementation ticket at {path to ticket} with spec at {path to spec} with a zero-trust mindset. Verify the code is actually built properly, safely, and honestly. Detect shortcuts, hardcoding, dead code, unused files, incomplete work, and anything that creates a false impression of completion. Give a requirement-by-requirement verdict with file-level evidence and fixes." as const;

export interface AuditPromptInput {
	readonly featureName: string;
	readonly acceptedCommitIds: readonly string[];
	readonly ticketPath: string;
	readonly specPath: string;
}

function substitute(template: string, marker: string, value: string): string {
	return template.split(marker).join(value);
}

export function buildAuditPrompt(input: AuditPromptInput, template: string = AUDIT_PROMPT_TEMPLATE): string {
	const values: readonly [string, string][] = [
		["{name feature}", input.featureName],
		["{git id for all the commit when implementing}", input.acceptedCommitIds.join(" ")],
		["{path to ticket}", input.ticketPath],
		["{path to spec}", input.specPath],
	];
	return values.reduce((result, [marker, value]) => substitute(result, marker, value), template);
}

export function assertExactAuditPrompt(prompt: string, input: AuditPromptInput, template: string = AUDIT_PROMPT_TEMPLATE): void {
	if (prompt !== buildAuditPrompt(input, template)) throw new Error("Audit prompt is not exactly the immutable Ticket Flow audit template substitution.");
}

export function auditProfile(profile: PiLaunchProfile | undefined): PiLaunchProfile {
	if (!profile?.model || !profile.thinking) throw new Error("Audit requires an explicit model and thinking level; no fallback is permitted.");
	return { model: profile.model, thinking: profile.thinking };
}

export function createAuditState(input: AuditPromptInput & { readonly profile: PiLaunchProfile }): AuditRunState {
	const profile = auditProfile(input.profile);
	return {
		featureName: input.featureName,
		ticketPath: input.ticketPath,
		specPath: input.specPath,
		template: AUDIT_PROMPT_TEMPLATE,
		model: profile.model,
		thinking: profile.thinking,
		rounds: [],
	};
}

export function auditReportFindings(report: WorkerReport): readonly AuditFinding[] {
	return report.auditFindings ?? [];
}

export function auditReportVerdicts(report: WorkerReport): readonly AuditRequirementVerdict[] {
	return report.auditVerdicts ?? [];
}

export function validateAuditReport(report: WorkerReport, requirements: readonly string[]): void {
	if (report.status !== "completed") throw new Error("Audit report must be a completed report.");
	const verdicts = auditReportVerdicts(report);
	if (verdicts.length !== requirements.length) throw new Error("Audit report must give exactly one verdict for every implementation requirement.");
	const seen = new Set<string>();
	for (const verdict of verdicts) {
		if (!verdict.requirement.trim() || !verdict.evidence.trim()) throw new Error("Audit verdicts require requirement text and file-level evidence.");
		if (seen.has(verdict.requirement)) throw new Error(`Duplicate audit verdict: ${verdict.requirement}`);
		seen.add(verdict.requirement);
		if (!requirements.includes(verdict.requirement)) throw new Error(`Audit verdict references an unknown requirement: ${verdict.requirement}`);
	}
	if (verdicts.some((verdict) => verdict.verdict === "fail") && auditReportFindings(report).length === 0) {
		throw new Error("A failing audit verdict must include at least one finding.");
	}
	for (const finding of auditReportFindings(report)) {
		if (!finding.id.trim() || !finding.finding.trim() || !finding.evidence.trim()) throw new Error("Audit findings require stable IDs, findings, and evidence.");
	}
}

export function auditEvidenceHash(findings: readonly AuditFinding[]): string {
	return createHash("sha256").update(JSON.stringify(findings.map(({ id, evidence, finding }) => ({ id, evidence, finding })))).digest("hex");
}

export function acceptedCommitsForAudit(state: AuditRunState, git: Parameters<typeof acceptedCommitRange>[0]): string {
	return acceptedCommitRange(git);
}

function boundSummary(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const notice = "\n[Final summary truncated]";
	if (maxBytes <= Buffer.byteLength(notice)) return notice.slice(0, Math.max(0, maxBytes));
	let output = "";
	let bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size + Buffer.byteLength(notice) > maxBytes) break;
		output += character;
		bytes += size;
	}
	return `${output}${notice}`;
}

/** Detailed but bounded terminal evidence summary; report bodies stay on disk. */
export function formatFinalSummary(run: WorkflowRun, maxBytes = 48 * 1024): string {
	const lines: string[] = [
		`Ticket Flow completed: ${run.plan.summary || run.originalPrompt}`,
		`Run: ${run.id}`,
		`Phase: ${run.phase}`,
		`Accepted commits: ${run.git?.acceptedCommitIds.join(" ") || "(no Git repository or accepted commits)"}`,
	];
	for (const item of run.plan.workItems) {
		if (item.kind === "audit") continue;
		const completion = item.completion;
		lines.push(`Work item ${item.id}: ${item.status}${completion ? ` · attempt ${completion.acceptedAttempt} · report ${completion.acceptedReportPath}${completion.commitIds?.length ? ` · commits ${completion.commitIds.join(" ")}` : ""}` : ""}`);
		if (completion?.worker) lines.push(`  worker: ${completion.worker.provider}/${completion.worker.model} (${completion.worker.thinking})`);
	}
	for (const round of run.audit?.rounds ?? []) {
		lines.push(`Audit round ${round.round}: ${round.status} · worker ${round.workerItemId} · commits ${round.acceptedCommitIds.join(" ") || "(none)"}${round.reportPath ? ` · report ${round.reportPath}` : ""}`);
		for (const finding of round.findings ?? []) {
			lines.push(`  Finding ${finding.id} (${finding.severity}): ${finding.resolved ? "resolved" : "addressed via " + (finding.fixLink ?? "manual intervention")} · ${finding.finding} · evidence: ${finding.evidence}`);
		}
		if (round.fixWorkItemId) lines.push(`  Fix worker: ${round.fixWorkItemId}`);
	}
	if ((run.reportReferences ?? []).length > 0) {
		lines.push("Durable report references:");
		for (const reference of run.reportReferences ?? []) lines.push(`  ${reference.workItemId} attempt ${reference.attempt}: ${reference.path}`);
	}
	return boundSummary(lines.join("\n"), maxBytes);
}

export type AuditPersist = (
	next: WorkflowRun,
	eventType: string,
	data: unknown,
) => Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError>;

export interface AuditProgressionDependencies {
	readonly now: () => Date;
	readonly persist: AuditPersist;
	readonly gitRunner?: GitCommandRunner;
}

export interface AuditAdvanceResult {
	readonly run: WorkflowRun;
	readonly terminal: boolean;
}

export interface AuditRoundReduction {
	readonly auditRound: AuditRound;
	readonly auditState: AuditRunState;
	readonly findings: readonly AuditFinding[];
	readonly linkedFindings: readonly AuditFinding[];
	readonly sameEvidence: boolean;
	readonly occurrences: number;
	readonly fixWorkItemId?: string;
}

/**
 * Purely derives the durable round and no-progress state from one accepted
 * audit report. Side effects are deliberately kept out of this reducer.
 */
export function reduceAuditRound(
	run: WorkflowRun,
	itemId: string,
	report: WorkerReport,
	reportPath: string,
	now: string,
): AuditRoundReduction | undefined {
	if (!run.audit) return undefined;
	const roundNumber = run.audit.activeRound ?? run.audit.rounds.length;
	const existingRound = run.audit.rounds.find((round) => round.round === roundNumber);
	if (existingRound?.reportPath === reportPath || (existingRound?.workerItemId === itemId && existingRound.status !== "pending")) return undefined;
	const findings = [...auditReportFindings(report)];
	const verdicts = [...auditReportVerdicts(report)];
	const evidenceHash = auditEvidenceHash(findings);
	const previous = run.audit.rounds.at(-1);
	const sameEvidence = previous?.status === "findings" && evidenceHash === auditEvidenceHash(previous.findings ?? []);
	const occurrences = sameEvidence ? (run.audit.noProgress?.occurrences ?? 1) + 1 : 1;
	const fixWorkItemId = findings.length > 0 ? `fix-round-${roundNumber}` : undefined;
	const linkedFindings = fixWorkItemId === undefined ? findings : findings.map((finding) => ({ ...finding, fixLink: fixWorkItemId }));
	const auditItem = run.plan.workItems.find((item) => item.id === itemId);
	const timestamp = now;
	const auditRound: AuditRound = {
		round: roundNumber,
		workerItemId: itemId,
		prompt: itemId.startsWith("audit-") ? auditItem?.delegationPrompt ?? "" : "",
		acceptedCommitIds: run.git?.acceptedCommitIds ?? [],
		reportPath,
		verdicts,
		findings: linkedFindings,
		...(fixWorkItemId === undefined ? {} : { fixWorkItemId }),
		status: findings.length > 0 ? "findings" : "clean",
		createdAt: timestamp,
		completedAt: timestamp,
	};
	const { activeRound: _activeRound, ...auditWithoutActiveRound } = run.audit;
	const auditState: AuditRunState = {
		...auditWithoutActiveRound,
		rounds: [...run.audit.rounds.filter((candidate) => candidate.round !== roundNumber), auditRound],
		...(sameEvidence ? { noProgress: { findingId: findings[0]?.id ?? "unknown", occurrences, evidenceHash } } : {}),
	};
	return { auditRound, auditState, findings, linkedFindings, sameEvidence, occurrences, ...(fixWorkItemId === undefined ? {} : { fixWorkItemId }) };
}

function ensureAuditWorktree(run: WorkflowRun, reason: string, dependencies: AuditProgressionDependencies): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		if (run.git === undefined) return run;
		const check = yield* Effect.result(Effect.tryPromise({
			try: (signal) => assertGitReadyForAudit(run.projectPath, run.git!, dependencies.gitRunner, signal),
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		}));
		if (check._tag === "Success") return run;
		const paused = run.phase === "paused" ? run.phase : yield* transitionRun(run.phase, "paused");
		const timestamp = dependencies.now().toISOString();
		return yield* dependencies.persist({
			...run,
			phase: paused,
			pauseReason: "recovery",
			recoveryIssue: { kind: "audit-worktree", message: `Audit cannot begin until the dedicated workflow branch has a clean worktree: ${check.failure.message}` },
			updatedAt: timestamp,
		}, "audit-worktree-paused", { reason, message: check.failure.message });
	});
}

function auditRequirements(run: WorkflowRun): { readonly items: readonly WorkItem[]; readonly sourcePaths: readonly string[]; readonly specificationPaths: readonly string[] } {
	const items = run.plan.workItems.filter((item) => item.kind !== "audit" && item.kind !== "fix");
	return {
		items,
		sourcePaths: [...new Set(items.flatMap((item) => item.sourcePaths))],
		specificationPaths: [...new Set(items.flatMap((item) => item.specificationPaths))],
	};
}

function generatedAuditItem(
	run: WorkflowRun,
	round: number,
	featureName: string,
	prompt: string,
	orderReason: string,
	status: WorkItem["status"] = "ready",
): WorkItem {
	const requirements = auditRequirements(run);
	return {
		id: `audit-round-${round}`,
		kind: "audit",
		title: round === 1 ? `Audit · ${featureName}` : `Audit round ${round} · ${featureName}`,
		sourcePaths: requirements.sourcePaths,
		specificationPaths: requirements.specificationPaths,
		requirements: [...new Set(requirements.items.flatMap((item) => item.requirements))],
		order: Math.max(...run.plan.workItems.map((item) => item.order), 0) + 1,
		orderReason,
		dependsOn: [],
		delegationPrompt: prompt,
		...(run.plan.auditProfile === undefined ? {} : { launchProfile: run.plan.auditProfile }),
		readOnly: true,
		completionStrategy: { type: "ledger-only" },
		status,
	};
}

function scheduleFreshAudit(run: WorkflowRun, dependencies: AuditProgressionDependencies): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		if (!run.audit || !run.plan.auditProfile) return yield* Effect.fail(new Error("Fresh audit requires an explicit plan audit profile."));
		const { items, sourcePaths, specificationPaths } = auditRequirements(run);
		const round = Math.max(0, ...run.audit.rounds.map((candidate) => candidate.round)) + 1;
		if (run.plan.workItems.some((item) => item.id === `audit-round-${round}`)) return run;
		const auditReady = yield* ensureAuditWorktree(run, "fresh-audit", dependencies);
		if (auditReady.phase === "paused") return auditReady;
		const prompt = buildAuditPrompt({ featureName: run.audit.featureName, acceptedCommitIds: run.git?.acceptedCommitIds ?? [], ticketPath: run.audit.ticketPath, specPath: run.audit.specPath });
		const item: WorkItem = {
			...generatedAuditItem(run, round, run.audit.featureName, prompt, "A fresh read-only audit follows every accepted fix."),
			sourcePaths,
			specificationPaths,
			requirements: [...new Set(items.flatMap((candidate) => candidate.requirements))],
		};
		const plan: WorkflowPlan = { ...run.plan, workItems: [...run.plan.workItems, item] };
		yield* validatePlan(plan, { allowGeneratedItems: true });
		const next: WorkflowRun = { ...run, phase: yield* transitionRun(run.phase, "auditing"), audit: { ...run.audit, activeRound: round }, plan, updatedAt: dependencies.now().toISOString() };
		return yield* dependencies.persist(next, "audit-round-created", { workItemId: item.id, round, prompt });
	});
}

/** Schedule the first audit, or the next fresh audit after a fix. */
export function scheduleAuditAfterAcceptance(
	run: WorkflowRun,
	completedWorkItemId: string,
	dependencies: AuditProgressionDependencies,
): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		if (run.audit !== undefined) {
			const latestRound = run.audit.rounds.at(-1);
			const hasPendingFix = run.plan.workItems.some((item) => item.kind === "fix" && item.status !== "completed");
			if (latestRound?.status === "findings" && !hasPendingFix) return yield* scheduleFreshAudit(run, dependencies);
			return run;
		}
		const explicitAuditProfile = run.plan.auditProfile;
		if (!explicitAuditProfile) {
			const paused = yield* transitionRun(run.phase, "paused");
			return yield* dependencies.persist({
				...run,
				phase: paused,
				pauseReason: "recovery",
				recoveryIssue: { kind: "audit-profile-required", message: "All implementation tickets are accepted. Set an explicit plan.auditProfile model and thinking level before auditing; no implementation profile fallback is permitted." },
				updatedAt: dependencies.now().toISOString(),
			}, "audit-profile-required", { completedWorkItemId });
		}
		const { items, sourcePaths, specificationPaths } = auditRequirements(run);
		if (items.some((item) => item.status !== "completed")) return run;
		const ticketPath = sourcePaths[0] ?? "";
		const specPath = specificationPaths[0] ?? "";
		if (!ticketPath || !specPath) return yield* Effect.fail(new Error("Audit requires at least one implementation ticket path and specification path."));
		const featureName = run.plan.summary.trim() || run.originalPrompt.trim();
		const auditReady = yield* ensureAuditWorktree(run, "initial-audit", dependencies);
		if (auditReady.phase === "paused") return auditReady;
		const prompt = buildAuditPrompt({ featureName, acceptedCommitIds: run.git?.acceptedCommitIds ?? [], ticketPath, specPath });
		const audit = createAuditState({ featureName, acceptedCommitIds: run.git?.acceptedCommitIds ?? [], ticketPath, specPath, profile: explicitAuditProfile });
		const item = generatedAuditItem(run, 1, featureName, prompt, "A fresh read-only zero-trust audit follows implementation acceptance.");
		const plan: WorkflowPlan = { ...run.plan, workItems: [...run.plan.workItems, item] };
		yield* validatePlan(plan, { allowGeneratedItems: true });
		const next: WorkflowRun = { ...run, phase: yield* transitionRun(run.phase, "auditing"), audit: { ...audit, activeRound: 1 }, updatedAt: dependencies.now().toISOString(), plan };
		return yield* dependencies.persist(next, "audit-created", { workItemId: item.id, prompt, template: AUDIT_PROMPT_TEMPLATE });
	});
}

/** Persist one accepted audit report and schedule its fix/fresh audit state. */
export function advanceAuditAfterAcceptance(
	run: WorkflowRun,
	itemId: string,
	report: WorkerReport,
	reportPath: string,
	dependencies: AuditProgressionDependencies,
): Effect.Effect<AuditAdvanceResult, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const reduced = reduceAuditRound(run, itemId, report, reportPath, dependencies.now().toISOString());
		if (!reduced) return { run, terminal: false };
		const { auditRound, auditState, findings, linkedFindings, sameEvidence, occurrences, fixWorkItemId } = reduced;
		const { progression: _pendingAuditProgression, ...withoutPendingAuditProgression } = run;
		if (findings.length > 0 && sameEvidence && occurrences >= 2) {
			const paused = yield* transitionRun(run.phase, "paused");
			const persisted = yield* dependencies.persist({
				...withoutPendingAuditProgression,
				phase: paused,
				pauseReason: "recovery",
				recoveryIssue: { kind: "audit-no-progress", message: "The same unresolved audit finding was reported twice without changed evidence; user intervention is required." },
				audit: auditState,
				updatedAt: dependencies.now().toISOString(),
			}, "audit-no-progress", { findingIds: findings.map((finding) => finding.id), evidenceHash: auditEvidenceHash(findings) });
			return { run: persisted, terminal: false };
		}
		if (findings.length > 0) {
			if (!run.plan.auditProfile) return yield* Effect.fail(new Error("Audit findings require the explicit plan audit profile for the fix worker."));
			const order = Math.max(...run.plan.workItems.map((candidate) => candidate.order), 0) + 1;
			const fixItem: WorkItem = {
				id: fixWorkItemId!,
				kind: "fix",
				title: `Fix audit round ${auditRound.round}`,
				sourcePaths: run.audit?.ticketPath ? [run.audit.ticketPath] : [],
				specificationPaths: run.audit?.specPath ? [run.audit.specPath] : [],
				auditFindingIds: findings.map((finding) => finding.id),
				requirements: findings.map((finding) => `${finding.id}: ${finding.finding}`),
				order,
				orderReason: "Audit findings schedule a dedicated fix worker before a fresh audit.",
				dependsOn: [],
				delegationPrompt: `Fix the audit findings for ${run.audit!.featureName}:\n${linkedFindings.map((finding) => `- ${finding.id}: ${finding.finding}\n  Evidence: ${finding.evidence}\n  Fix link: ${finding.fixLink}`).join("\n")}`,
				launchProfile: run.plan.auditProfile,
				completionStrategy: { type: "ledger-only" },
				status: "ready",
			};
			const existingFix = run.plan.workItems.find((item) => item.id === fixItem.id);
			const plan: WorkflowPlan = existingFix === undefined
				? { ...run.plan, workItems: [...run.plan.workItems, fixItem] }
				: { ...run.plan, workItems: run.plan.workItems.map((item) => item.id === fixItem.id ? { ...item, ...fixItem, status: item.status } : item) };
			yield* validatePlan(plan, { allowGeneratedItems: true });
			const fixing = yield* transitionRun(run.phase, "fixing");
			const persisted = yield* dependencies.persist({ ...withoutPendingAuditProgression, phase: fixing, audit: auditState, plan, updatedAt: dependencies.now().toISOString() }, "audit-findings-schedule-fix", { fixWorkItemId: fixItem.id, findingIds: findings.map((finding) => finding.id) });
			return { run: persisted, terminal: false };
		}
		const completed = yield* transitionRun(run.phase, "completed");
		const summaryRun: WorkflowRun = { ...withoutPendingAuditProgression, phase: completed, audit: auditState, updatedAt: dependencies.now().toISOString() };
		const finished = yield* dependencies.persist({ ...summaryRun, finalSummary: formatFinalSummary(summaryRun) }, "audit-clean", { round: auditRound.round });
		return { run: finished, terminal: true };
	});
}

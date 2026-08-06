import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuditFinding, RequirementVerdict, WorkerReport } from "./model.ts";

export const AUDIT_PROMPT_TEMPLATE = "Audit the implementation of {name of the feature or maybe for specific the git commit id of all the implementation} against the implementation ticket at {path to tickets directory and the reference file} with a zero-trust mindset. Verify the code is actually built properly, safely, and honestly. Detect shortcuts, hardcoding, dead code, unused files, incomplete work, and anything that creates a false impression of completion. Give a requirement-by-requirement verdict with file-level evidence and fixes." as const;
export const AUDIT_FEATURE_MARKER = "{name of the feature or maybe for specific the git commit id of all the implementation}" as const;
export const AUDIT_REFERENCE_MARKER = "{path to tickets directory and the reference file}" as const;

function safeSubstitution(value: string, field: string): string {
	if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Audit ${field} substitution must be non-empty and control-free.`);
	return value;
}

export interface AuditPromptResult {
	readonly prompt: string;
	readonly hash: string;
	readonly substitutions: Readonly<Record<string, string>>;
}

export function buildAuditPrompt(input: {
	readonly featureOrCommits: string;
	readonly ticketsAndReferences: string;
}): AuditPromptResult {
	const featureOrCommits = safeSubstitution(input.featureOrCommits, "feature/commits");
	const ticketsAndReferences = safeSubstitution(input.ticketsAndReferences, "ticket/reference");
	const prompt = AUDIT_PROMPT_TEMPLATE
		.replace(AUDIT_FEATURE_MARKER, featureOrCommits)
		.replace(AUDIT_REFERENCE_MARKER, ticketsAndReferences);
	if (Buffer.byteLength(prompt, "utf8") > 30 * 1024 || prompt.split("\n").length > 1_500) throw new Error("Audit prompt exceeds Ticket Flow transport bounds.");
	return {
		prompt,
		hash: createHash("sha256").update(prompt).digest("hex"),
		substitutions: { [AUDIT_FEATURE_MARKER]: featureOrCommits, [AUDIT_REFERENCE_MARKER]: ticketsAndReferences },
	};
}

function hasFileLevelEvidence(value: string): boolean {
	return /(?:^|\s)[^\s:]+:\d+(?:-\d+)?(?:\s|$)/.test(value);
}

export function validateAuditReport(report: WorkerReport, acceptedCommitIds: readonly string[], expectedRequirements?: readonly string[]): asserts report is Extract<WorkerReport, { status: "audit" }> {
	if (report.status !== "audit") throw new Error("An audit assignment requires an audit report.");
	if (report.verdicts.length === 0) throw new Error("Audit report must contain at least one requirement verdict with file-level evidence.");
	if (report.auditedCommitIds.length !== acceptedCommitIds.length || report.auditedCommitIds.some((commit, index) => commit !== acceptedCommitIds[index])) {
		throw new Error("Audit report commit IDs do not exactly match the persisted accepted commit set.");
	}
	const requirements = new Set<string>();
	for (const verdict of report.verdicts) {
		if (!verdict.requirement.trim() || !verdict.evidence.trim() || !hasFileLevelEvidence(verdict.evidence)) throw new Error("Audit verdicts require requirement text and path:line file-level evidence.");
		if (requirements.has(verdict.requirement)) throw new Error(`Duplicate audit verdict: ${verdict.requirement}`);
		requirements.add(verdict.requirement);
	}
	if (expectedRequirements !== undefined) {
		const expected = [...new Set(expectedRequirements)];
		if (expected.length === 0 || report.verdicts.length !== expected.length || expected.some((requirement) => !requirements.has(requirement))) throw new Error("Audit report must contain exactly one verdict for every canonical ticket requirement.");
	}
	const findingIds = new Set<string>();
	for (const finding of report.findings) {
		if (!finding.id.trim() || !finding.finding.trim() || !finding.evidence.trim() || !hasFileLevelEvidence(finding.evidence)) throw new Error("Audit findings require stable IDs, findings, and path:line evidence.");
		if (findingIds.has(finding.id)) throw new Error(`Duplicate audit finding: ${finding.id}`);
		findingIds.add(finding.id);
	}
	if (report.verdicts.some((verdict) => verdict.verdict === "fail") && report.findings.length === 0) throw new Error("Failing audit verdicts require findings.");
	if (report.findings.length > 0 && report.verdicts.every((verdict) => verdict.verdict !== "fail")) throw new Error("Audit findings require at least one failing verdict.");
}

export async function verifyAuditEvidence(projectPath: string, report: Extract<WorkerReport, { status: "audit" }>): Promise<void> {
	const project = await realpath(projectPath);
	for (const evidence of [...report.verdicts.map((verdict) => verdict.evidence), ...report.findings.map((finding) => finding.evidence)]) {
		const references = [...evidence.matchAll(/(?:^|\s)([^\s:]+):(\d+)(?:-\d+)?(?:\s|$)/g)];
		if (references.length === 0) throw new Error("Audit evidence has no path:line reference.");
		for (const reference of references) {
			const candidate = path.resolve(project, reference[1]!);
			const relative = path.relative(project, candidate);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Audit evidence path is outside the project: ${reference[1]}`);
			const canonical = await realpath(candidate);
			if (canonical !== candidate) throw new Error(`Audit evidence path contains a symlink: ${reference[1]}`);
			const metadata = await lstat(canonical);
			if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Audit evidence path is not a regular file: ${reference[1]}`);
			const line = Number(reference[2]);
			const lineCount = (await readFile(canonical, "utf8")).split("\n").length;
			if (!Number.isSafeInteger(line) || line < 1 || line > lineCount) throw new Error(`Audit evidence line is outside ${reference[1]}: ${line}`);
		}
	}
}

export function findingsHash(findings: readonly AuditFinding[]): string {
	const normalized = findings.map(({ id, finding, evidence }) => ({ id, finding, evidence }))
		.sort((left, right) => left.id.localeCompare(right.id));
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function buildFixPrompt(findings: readonly AuditFinding[], auditedCommitIds: readonly string[]): string {
	if (findings.length === 0) throw new Error("A fixer requires at least one audit finding.");
	const prompt = [
		`Fix the following zero-trust audit findings against commits ${auditedCommitIds.join(" ")}:`,
		...findings.map((finding) => `- ${finding.id} (${finding.severity}): ${finding.finding}\n  Evidence: ${finding.evidence}${finding.fix ? `\n  Required fix: ${finding.fix}` : ""}`),
		"Commit every fix and report the new commit IDs.",
	].join("\n");
	if (Buffer.byteLength(prompt, "utf8") > 30 * 1024 || prompt.split("\n").length > 1_500) throw new Error("Fix prompt exceeds Ticket Flow transport bounds.");
	return prompt;
}

export type { AuditFinding, RequirementVerdict };

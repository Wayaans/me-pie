import assert from "node:assert/strict";
import test from "node:test";
import {
	AUDIT_FEATURE_MARKER,
	AUDIT_PROMPT_TEMPLATE,
	AUDIT_REFERENCE_MARKER,
	buildAuditPrompt,
	buildFixPrompt,
	validateAuditReport,
} from "../ticket-flow/audit.ts";

const commits = ["a".repeat(40), "b".repeat(40)];

test("audit prompt is the byte-exact immutable two-placeholder substitution", () => {
	const result = buildAuditPrompt({ featureOrCommits: commits.join(" "), ticketsAndReferences: "/project/tickets, /project/spec.md" });
	assert.equal(result.prompt, AUDIT_PROMPT_TEMPLATE
		.replace(AUDIT_FEATURE_MARKER, commits.join(" "))
		.replace(AUDIT_REFERENCE_MARKER, "/project/tickets, /project/spec.md"));
	assert.equal(result.prompt.includes(AUDIT_FEATURE_MARKER), false);
	assert.equal(result.prompt.includes(AUDIT_REFERENCE_MARKER), false);
	assert.equal(result.hash.length, 64);
	assert.throws(() => buildAuditPrompt({ featureOrCommits: "feature\tname", ticketsAndReferences: "/tickets" }), /control-free/);
	assert.throws(() => buildAuditPrompt({ featureOrCommits: "feature", ticketsAndReferences: "/tickets\u0007" }), /control-free/);
});

test("empty or scope-mismatched audit reports can never complete a run", () => {
	assert.throws(() => validateAuditReport({ status: "audit", summary: "empty", verdicts: [], findings: [], auditedCommitIds: commits }, commits), /at least one requirement verdict/);
	assert.throws(() => validateAuditReport({
		status: "audit", summary: "wrong scope", verdicts: [{ requirement: "R1", verdict: "pass", evidence: "src/a.ts:1" }], findings: [], auditedCommitIds: [commits[0]!],
	}, commits), /exactly match/);
	assert.throws(() => validateAuditReport({
		status: "audit", summary: "vague", verdicts: [{ requirement: "R1", verdict: "pass", evidence: "looks good" }], findings: [], auditedCommitIds: commits,
	}, commits), /path:line/);
	assert.throws(() => validateAuditReport({
		status: "audit", summary: "dishonest", verdicts: [{ requirement: "R1", verdict: "fail", evidence: "src/a.ts:1" }], findings: [], auditedCommitIds: commits,
	}, commits), /require findings/);
	assert.throws(() => validateAuditReport({
		status: "audit", summary: "partial", verdicts: [{ requirement: "R1", verdict: "pass", evidence: "src/a.ts:1" }], findings: [], auditedCommitIds: commits,
	}, commits, ["R1", "R2"]), /every canonical ticket requirement/);
	assert.doesNotThrow(() => validateAuditReport({
		status: "audit", summary: "clean", verdicts: [{ requirement: "R1", verdict: "pass", evidence: "src/a.ts:1" }], findings: [], auditedCommitIds: commits,
	}, commits));
});

test("fix prompts are finding-bound and rejected before transport overflow", () => {
	const prompt = buildFixPrompt([{ id: "F1", severity: "high", finding: "Broken", evidence: "src/a.ts:1", fix: "Repair it" }], commits);
	assert.match(prompt, /F1 \(high\): Broken/);
	assert.match(prompt, /Evidence: src\/a\.ts:1/);
	assert.throws(() => buildFixPrompt(Array.from({ length: 20 }, (_, index) => ({
		id: `F${index}`, severity: "high" as const, finding: "x".repeat(2_000), evidence: "src/a.ts:1",
	})), commits), /transport bounds/);
});

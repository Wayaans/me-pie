import assert from "node:assert/strict";
import test from "node:test";
import { auditToolCallBlocked, isAuditBashCommandAllowed, workerActiveToolNames } from "../ticket-flow/index.ts";
import { buildWorkerEnvironment } from "../ticket-flow/tmux/command.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };

test("worker activation preserves implementation tools and restricts audit tools", () => {
	const normal = workerActiveToolNames(["read", "bash", "edit", "write", "workflow_plan"], "fix");
	assert.deepEqual(normal, ["read", "bash", "edit", "write", "workflow_plan", "workflow_worker"]);
	const audit = workerActiveToolNames(["read", "bash", "edit", "write", "rg", "workflow_plan"], "audit");
	assert.deepEqual(audit, ["read", "grep", "find", "ls", "rg", "fd", "bash", "workflow_worker"]);
	assert.equal(auditToolCallBlocked({ toolName: "edit", input: {} }) !== undefined, true);
	assert.equal(auditToolCallBlocked({ toolName: "bash", input: { command: "git status --short" } }), undefined);
	assert.equal(auditToolCallBlocked({ toolName: "bash", input: { command: "git reset --hard" } }) !== undefined, true);
	assert.equal(auditToolCallBlocked({ toolName: "git", input: { args: ["commit"] } }) !== undefined, true);
});

test("audit launch metadata is separate from the worker prompt", () => {
	const environment = buildWorkerEnvironment({ runId: "run", workItemId: "audit-1", profile, kind: "audit", socketPath: "/tmp/audit.sock", token: "token" });
	assert.equal(environment.MEPIE_WORKFLOW_ROLE, "worker");
	assert.equal(environment.MEPIE_WORKFLOW_WORKER_KIND, "audit");
	assert.equal(isAuditBashCommandAllowed("bun run check"), false);
	assert.equal(isAuditBashCommandAllowed("npm test"), false);
	assert.equal(isAuditBashCommandAllowed("cargo test"), false);
	assert.equal(isAuditBashCommandAllowed("git status --short"), true);
	assert.equal(isAuditBashCommandAllowed("git diff --output=changed.txt"), false);
	assert.equal(isAuditBashCommandAllowed("find . -exec touch changed.txt \\;"), false);
	assert.equal(isAuditBashCommandAllowed("printf ok > changed.txt"), false);
});

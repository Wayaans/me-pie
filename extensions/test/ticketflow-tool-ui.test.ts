import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerMainTools } from "../ticket-flow/index.ts";
import type { WorkerReport } from "../ticket-flow/model.ts";
import {
	formatWaitResultMarkdown,
	formatWorkerReportMarkdown,
	runWithTicketflowProgress,
} from "../ticket-flow/tool-ui.ts";

interface CapturedTool {
	readonly name: string;
	readonly renderCall?: (args: any, theme: any, context: any) => Component;
	readonly renderResult?: (result: any, options: any, theme: any, context: any) => Component;
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function tools(): Map<string, CapturedTool> {
	const registered = new Map<string, CapturedTool>();
	registerMainTools({
		registerTool(tool: CapturedTool) { registered.set(tool.name, tool); },
	} as never, {} as never);
	return registered;
}

function rendered(component: Component): string {
	return component.render(100).join("\n");
}

function resultContext(args: unknown, isError = false): any {
	return { args, isError, state: {}, lastComponent: undefined };
}

initTheme();

test("every Main tool provides polished call and result renderers", () => {
	for (const [name, tool] of tools()) {
		assert.equal(typeof tool.renderCall, "function", `${name} renderCall`);
		assert.equal(typeof tool.renderResult, "function", `${name} renderResult`);
	}
});

test("delegate UI never reveals the initial task or send instruction", () => {
	const tool = tools().get("ticketflow_delegate")!;
	assert.ok(tool.renderCall && tool.renderResult);
	const output = rendered(tool.renderResult!(
		{
			content: [{ type: "text", text: "Send this exact initial task with ticketflow_send:\n\nSECRET TASK" }],
			details: { result: { workerId: "worker-1", assignmentKind: "implementation", initialTask: "SECRET TASK" } },
		},
		{ expanded: true, isPartial: false },
		plainTheme,
		resultContext({}),
	));
	assert.match(output, /✓ Worker ready · implementation · worker-1/);
	assert.doesNotMatch(output, /SECRET TASK|Send this exact initial task/);
});

test("send UI renders the delivered message as Markdown", () => {
	const tool = tools().get("ticketflow_send")!;
	assert.ok(tool.renderResult);
	const output = rendered(tool.renderResult!(
		{ content: [{ type: "text", text: "Delivered" }], details: { turn: 2 } },
		{ expanded: false, isPartial: false },
		plainTheme,
		resultContext({ workerId: "worker-1", delivery: "follow-up", message: "## Fix\n\n- Keep **tests** green" }),
	));
	assert.match(output, /✓ Delivered · turn 2/);
	assert.match(output, /Fix/);
	assert.match(output, /Keep tests green/);
});

test("wait UI shows elapsed time while pending and readable Markdown when settled", () => {
	const tool = tools().get("ticketflow_wait")!;
	assert.ok(tool.renderResult);
	const pending = rendered(tool.renderResult!(
		{
			content: [{ type: "text", text: "Waiting" }],
			details: { ticketflowUi: { label: "Waiting", elapsedMs: 12_340, frame: 2 } },
		},
		{ expanded: false, isPartial: true },
		plainTheme,
		resultContext({ workerId: "worker-1" }),
	));
	assert.match(pending, /Waiting · 12\.3s/);

	const report: WorkerReport = { status: "blocked", summary: "Need a choice", questions: ["Use A or B?"] };
	const waitResult = {
		workerId: "worker-1",
		turn: 3,
		status: "reported" as const,
		report,
		worker: { provider: "p", model: "m", thinking: "medium" as const, sessionId: "s", sessionFile: "/tmp/s" },
	};
	const settled = rendered(tool.renderResult!(
		{ content: [{ type: "text", text: formatWaitResultMarkdown(waitResult) }], details: { result: waitResult, elapsedMs: 12_500 } },
		{ expanded: false, isPartial: false },
		plainTheme,
		resultContext({ workerId: "worker-1" }),
	));
	assert.match(settled, /✓ Settled · turn 3 · reported · 12\.5s/);
	assert.match(settled, /Blocked/);
	assert.match(settled, /Use A or B\?/);
	assert.doesNotMatch(settled, /\{"|"status"|"questions"/);
});

test("report Markdown covers completion and audit details without JSON", () => {
	const audit: WorkerReport = {
		status: "audit",
		summary: "One issue found",
		auditedCommitIds: ["abc123"],
		verdicts: [{ requirement: "Save data", verdict: "fail", evidence: "src/store.ts:10", fixes: ["Persist before exit"] }],
		findings: [{ id: "F-1", severity: "high", finding: "Data is lost", evidence: "src/store.ts:10", fix: "Write the file" }],
	};
	const markdown = formatWorkerReportMarkdown(audit);
	assert.match(markdown, /◇ Audit/);
	assert.match(markdown, /✕ \*\*Save data\*\*/);
	assert.match(markdown, /HIGH · F-1/);
	assert.doesNotMatch(markdown, /\{"|"status"|"verdicts"/);
});

test("tool errors use a concise failure state", () => {
	const tool = tools().get("ticketflow_close")!;
	const output = rendered(tool.renderResult!(
		{ content: [{ type: "text", text: "Completion gate rejected" }], details: undefined },
		{ expanded: false, isPartial: false },
		plainTheme,
		resultContext({ workerId: "worker-1" }, true),
	));
	assert.equal(output.trimEnd(), "✕ Failed · Completion gate rejected");
});

test("progress updates animate and advance elapsed time", async () => {
	const updates: Array<{ details: { ticketflowUi: { elapsedMs: number; frame: number } } }> = [];
	await runWithTicketflowProgress("Waiting", (update) => updates.push(update as typeof updates[number]), async () => {
		await new Promise((resolve) => setTimeout(resolve, 190));
	});
	assert.ok(updates.length >= 2);
	assert.ok(updates.at(-1)!.details.ticketflowUi.elapsedMs >= 100);
	assert.notEqual(updates[0]!.details.ticketflowUi.frame, updates.at(-1)!.details.ticketflowUi.frame);
});

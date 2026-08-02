import assert from "node:assert/strict";
import test from "node:test";
import { type Component, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import askMe from "../ask-me/index.ts";
import { AskMeQuestionnaire } from "../ask-me/questionnaire.ts";
import {
	type AskMeDetails,
	formatAskMeTranscript,
	normalizeAskMeRequest,
} from "../ask-me/schema.ts";

const mixedInput = {
	title: "Deployment choices",
	questions: [
		{
			id: "database",
			type: "selection" as const,
			question: "Which database should the project use?",
			detail: "This affects production deployment.",
			options: [
				{ value: "postgres", label: "PostgreSQL", description: "Supports concurrent writes." },
				{ value: "sqlite", label: "SQLite" },
			],
			recommendation: {
				answer: "postgres",
				reason: "Production requires concurrent writes.",
			},
		},
		{
			id: "migrations",
			type: "confirmation" as const,
			question: "Should migrations run during deployment?",
		},
	],
};

test("ask-me normalizes a mixed questionnaire and recommendation", () => {
	const request = normalizeAskMeRequest(mixedInput);
	assert.equal(request.displayType, "questionnaire");
	assert.equal(request.questions[0]?.required, true);
	assert.equal(request.questions[0]?.allowOther, false);
	assert.deepEqual(request.questions[0]?.recommendation, {
		answer: "postgres",
		reason: "Production requires concurrent writes.",
	});
});

test("ask-me derives the single-question display type", () => {
	const request = normalizeAskMeRequest({
		questions: [{ id: "name", type: "question", question: "What should this package be called?" }],
	});
	assert.equal(request.displayType, "question");
});

test("ask-me rejects invalid selection recommendations", () => {
	assert.throws(
		() => normalizeAskMeRequest({
			questions: [{
				id: "database",
				type: "selection",
				question: "Which database?",
				options: [{ value: "postgres", label: "PostgreSQL" }],
				recommendation: { answer: "mysql", reason: "A reason" },
			}],
		}),
		/must match a selection option value/,
	);
});

test("ask-me transcript permanently includes every submitted question and answer", () => {
	const request = normalizeAskMeRequest(mixedInput);
	const details: AskMeDetails = {
		...request,
		status: "submitted",
		answers: [
			{ id: "database", value: "postgres", label: "PostgreSQL", source: "recommended" },
			{ id: "migrations", value: "yes", label: "Yes", source: "selected" },
		],
	};
	const transcript = formatAskMeTranscript(details);
	assert.match(transcript, /Q1\. Which database should the project use\?/);
	assert.match(transcript, /A1\. PostgreSQL/);
	assert.match(transcript, /Used recommendation: Production requires concurrent writes\./);
	assert.match(transcript, /Q2\. Should migrations run during deployment\?/);
	assert.match(transcript, /A2\. Yes/);
});

test("ask-me cancellation prints partial and unanswered results without inferring answers", () => {
	const request = normalizeAskMeRequest(mixedInput);
	const transcript = formatAskMeTranscript({
		...request,
		status: "cancelled",
		answers: [{ id: "database", value: "postgres", label: "PostgreSQL", source: "selected" }],
	});
	assert.match(transcript, /cancelled after answering 1 of 2/);
	assert.match(transcript, /Do not infer answers/);
	assert.match(transcript, /A2\. \(not answered\)/);
});

interface CapturedTool {
	executionMode?: string;
	renderShell?: string;
	execute: (...args: unknown[]) => Promise<unknown>;
	renderCall: (args: unknown, theme: unknown, context: unknown) => Component;
	renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => Component;
}

function captureTool(): CapturedTool {
	let captured: unknown;
	askMe({ registerTool(tool: unknown) { captured = tool; } } as never);
	assert.ok(captured);
	return captured as CapturedTool;
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderContext() {
	return {
		args: mixedInput,
		state: {},
		lastComponent: undefined,
		invalidate() {},
		toolCallId: "tool-1",
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

test("ask-me questionnaire never renders lines wider than the terminal", () => {
	const request = normalizeAskMeRequest(mixedInput);
	const component = new AskMeQuestionnaire(
		request,
		{ requestRender() {} } as never,
		plainTheme as never,
		{ matches: () => false } as never,
		() => {},
	);
	for (const width of [1, 12, 40, 100]) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("ask-me recommendation shortcut fills without submitting and requires explicit confirmation", () => {
	const request = normalizeAskMeRequest({
		questions: [{
			id: "database",
			type: "question",
			question: "Which database should the project use?",
			recommendation: { answer: "PostgreSQL", reason: "It supports concurrent writes." },
		}],
	});
	const completed: AskMeDetails[] = [];
	const keybindings = {
		matches(data: string, id: string) {
			if (id === "tui.input.submit" || id === "tui.select.confirm") return matchesKey(data, Key.enter);
			if (id === "tui.input.newLine") return matchesKey(data, Key.shift("enter"));
			if (id === "tui.select.cancel") return matchesKey(data, Key.escape);
			return false;
		},
	};
	const component = new AskMeQuestionnaire(
		request,
		{ requestRender() {} } as never,
		plainTheme as never,
		keybindings as never,
		(result) => { completed.push(result); },
	);

	component.handleInput("\u0012");
	assert.equal(completed.length, 0);
	component.handleInput("\r");
	assert.equal(completed.length, 0);
	component.handleInput("\r");
	assert.equal(completed[0]?.status, "submitted");
	assert.equal(completed[0]?.answers[0]?.source, "recommended");
});

test("ask-me RPC cancellation is not mistaken for skipping an optional question", async () => {
	const tool = captureTool();
	const result = await tool.execute(
		"tool-1",
		{
			questions: [{
				id: "notes",
				type: "selection",
				question: "Add release notes?",
				required: false,
				options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
			}],
		},
		undefined,
		undefined,
		{
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => undefined,
				input: async () => undefined,
				notify() {},
			},
		} as never,
	) as { details: AskMeDetails };
	assert.equal(result.details.status, "cancelled");
});

test("ask-me RPC exposes an explicit skip action for optional questions", async () => {
	const tool = captureTool();
	const result = await tool.execute(
		"tool-1",
		{
			questions: [{
				id: "notes",
				type: "selection",
				question: "Add release notes?",
				required: false,
				options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
			}],
		},
		undefined,
		undefined,
		{
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) => options.find((option) => option.includes("Skip")),
				input: async () => undefined,
				notify() {},
			},
		} as never,
	) as { content: Array<{ type: "text"; text: string }>; details: AskMeDetails };
	assert.equal(result.details.status, "submitted");
	assert.equal(result.details.answers.length, 0);
	assert.match(result.content[0]?.text ?? "", /submitted 0 answers for 1 question/);
	assert.match(result.content[0]?.text ?? "", /A1\. \(not answered\)/);
});

test("ask-me renderer updates its compact header and keeps answers visible while collapsed", () => {
	const tool = captureTool();
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.renderShell, undefined);
	const context = renderContext();
	const header = tool.renderCall(mixedInput, plainTheme, context);
	assert.match(header.render(120).join("\n"), /ask-me · questionnaire · \? waiting/);

	const request = normalizeAskMeRequest(mixedInput);
	const details: AskMeDetails = {
		...request,
		status: "submitted",
		answers: [
			{ id: "database", value: "postgres", label: "PostgreSQL", source: "selected" },
			{ id: "migrations", value: "yes", label: "Yes", source: "selected" },
		],
	};
	const transcript = formatAskMeTranscript(details);
	const result = tool.renderResult(
		{ content: [{ type: "text", text: transcript }], details },
		{ expanded: false, isPartial: false },
		plainTheme,
		context,
	);
	assert.match(header.render(120).join("\n"), /ask-me · questionnaire · ✓ done/);
	assert.match(result.render(120).join("\n"), /Q1\. Which database/);
	assert.match(result.render(120).join("\n"), /A2\. Yes/);
});

test("ask-me fails clearly when interactive input is unavailable", async () => {
	const tool = captureTool();
	await assert.rejects(
		tool.execute(
			"tool-1",
			mixedInput,
			undefined,
			undefined,
			{ mode: "print", hasUI: false } as never,
		),
		/UI is unavailable in print mode/,
	);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	getRecommendationPrefill,
	isAuthRelatedExtractionError,
	isRecoverableExtractionError,
	parseExtractionResult,
	QUESTION_EXTRACTION_SYSTEM_PROMPT,
	resolveExtractionThinking,
} from "../answer/index.ts";
import {
	DEFAULT_ANSWER_CONFIG,
	loadMergedAnswerConfig,
	updateProjectAnswerConfig,
} from "../answer/config.ts";
import { globalSettingsPath, projectSettingsPath } from "../mepie/settings.ts";

test("parseExtractionResult parses JSON code blocks", () => {
	const result = parseExtractionResult(
		"```json\n{\"questions\":[{\"question\":\"What is your name?\",\"context\":\"Optional context\"}]}\n```",
	);
	assert.deepEqual(result, {
		questions: [{ question: "What is your name?", context: "Optional context" }],
	});
});

test("parseExtractionResult extracts JSON from surrounding text", () => {
	const result = parseExtractionResult(
		"Here are the questions:\n{\"questions\":[{\"question\":\"Q1\",\"context\":\"  needs context  \"},{\"question\":\"Q2\"}]}\nDone.",
	);
	assert.deepEqual(result, {
		questions: [{ question: "Q1", context: "needs context" }, { question: "Q2" }],
	});
});

test("parseExtractionResult keeps question detail and removes recommendation labels", () => {
	const result = parseExtractionResult(
		JSON.stringify({
			questions: [
				{
					question: "  Which deployment strategy should we use while preserving rollback and existing health checks?  ",
					context: "  Available options are blue/green and rolling deployment.  ",
					recommendation: "  **Recommendation:** Use blue/green because rollback is required.  ",
				},
			],
		}),
	);

	assert.deepEqual(result, {
		questions: [
			{
				question: "Which deployment strategy should we use while preserving rollback and existing health checks?",
				context: "Available options are blue/green and rolling deployment.",
				recommendation: "Use blue/green because rollback is required.",
			},
		],
	});
});

test("question extraction prompt requests standalone questions without copying section headings", () => {
	assert.match(QUESTION_EXTRACTION_SYSTEM_PROMPT, /Rewrite each decision as a clear, direct, standalone question/);
	assert.match(QUESTION_EXTRACTION_SYSTEM_PROMPT, /Preserve the full intent/);
	assert.match(QUESTION_EXTRACTION_SYSTEM_PROMPT, /Do not use numbered headings or section titles as questions/);
	assert.match(QUESTION_EXTRACTION_SYSTEM_PROMPT, /without labels such as "Recommendation:"/);
	assert.match(QUESTION_EXTRACTION_SYSTEM_PROMPT, /Never invent a recommendation/);
});

test("recommendations prefill only empty answers", () => {
	assert.equal(getRecommendationPrefill("", "Use PostgreSQL"), "Use PostgreSQL");
	assert.equal(getRecommendationPrefill("   ", "  Use PostgreSQL  "), "Use PostgreSQL");
	assert.equal(getRecommendationPrefill("Use MySQL", "Use PostgreSQL"), undefined);
	assert.equal(getRecommendationPrefill("", undefined), undefined);
});

test("max thinking falls back to the highest level supported by older pi models", () => {
	const model = getModel("openai-codex", "gpt-5.5");
	assert.ok(model);
	assert.equal(resolveExtractionThinking(model, "off"), "off");
	assert.equal(resolveExtractionThinking(model, "medium"), "medium");
	assert.equal(resolveExtractionThinking(model, "max"), "xhigh");
});

test("parseExtractionResult trims and filters invalid question entries", () => {
	const result = parseExtractionResult(
		'{"questions":[{"question":"   Valid one  ","context":"  trim me  "},{"question":"   "},{"context":"missing question"},"ignore",{"question":"Another", "context":"   "}]}'
	);
	assert.deepEqual(result, {
		questions: [
			{ question: "Valid one", context: "trim me" },
			{ question: "Another" },
		],
	});
});

test("parseExtractionResult returns null for malformed JSON", () => {
	assert.equal(parseExtractionResult('{"questions":[{"question":"oops"'), null);
});

test("parseExtractionResult returns null for invalid shape", () => {
	assert.equal(parseExtractionResult('{"notQuestions":[]}'), null);
});

test("auth errors are recoverable", () => {
	assert.equal(isAuthRelatedExtractionError("No API key configured"), true);
	assert.equal(isRecoverableExtractionError("No API key configured"), true);
});

test("transient failures are recoverable", () => {
	assert.equal(isRecoverableExtractionError("Request timed out while calling model"), true);
	assert.equal(isRecoverableExtractionError("Service unavailable (502)"), true);
	assert.equal(isRecoverableExtractionError("fetch failed: ECONNRESET"), true);
});

test("non-recoverable failures are not retried", () => {
	assert.equal(isRecoverableExtractionError("Invalid role in request payload"), false);
});

test("answer config uses package defaults without overrides", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-answer-default-"));
	assert.deepEqual(loadMergedAnswerConfig(cwd), DEFAULT_ANSWER_CONFIG);
});

test("answer config layers trusted project fields over global fields", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-answer-override-"));
	const globalPath = globalSettingsPath();
	try {
		writeJson(globalPath, { answer: { model: "anthropic/claude-haiku-4-5", thinking: "low" } });
		writeJson(projectSettingsPath(cwd), { extensions: { webweb: false }, answer: { thinking: "max" } });

		assert.deepEqual(loadMergedAnswerConfig(cwd), { model: "anthropic/claude-haiku-4-5", thinking: "max" });
		assert.deepEqual(loadMergedAnswerConfig(cwd, { includeProject: false }), { model: "anthropic/claude-haiku-4-5", thinking: "low" });
	} finally {
		fs.rmSync(globalPath, { force: true });
	}
});

test("answer config writes preserve sibling Mepie settings and reject malformed files", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mepie-answer-write-"));
	const configPath = projectSettingsPath(cwd);
	writeJson(configPath, { extensions: { webweb: false }, localize: { thinking: "low" } });

	updateProjectAnswerConfig(cwd, { model: "openai-codex/gpt-5.5", thinking: "medium" });

	assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")), {
		extensions: { webweb: false },
		localize: { thinking: "low" },
		answer: { model: "openai-codex/gpt-5.5", thinking: "medium" },
	});

	fs.writeFileSync(configPath, "{broken");
	assert.throws(() => updateProjectAnswerConfig(cwd, { model: "openai-codex/gpt-5.5", thinking: "low" }), /Cannot read/);
	assert.equal(fs.readFileSync(configPath, "utf-8"), "{broken");
});

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

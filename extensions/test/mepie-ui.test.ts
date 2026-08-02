import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import mepieUi, {
	columns,
	extensionStatusValues,
	formatDirectory,
	formatTokens,
	sanitizeTerminalLabel,
	thinkingColorToken,
} from "../mepie-ui/index.ts";
import { parsePullRequestJson } from "../mepie-ui/git-info.ts";

test("mepie UI strips terminal control sequences from labels", () => {
	assert.equal(sanitizeTerminalLabel("main\u001b[31m-red\u001b[0m"), "main-red");
	assert.equal(sanitizeTerminalLabel("safe\u001b]0;malicious\u0007-title"), "safe-title");
});

test("dashboard columns never exceed the available width", () => {
	for (const width of [12, 40, 100]) {
		const rendered = columns(
			"~/Developer/a-very-long-project-name",
			"openai-codex/a-very-long-model-name · xhigh",
			width,
		);
		assert.ok(visibleWidth(rendered) <= width);
	}
});

test("dashboard formats token counts and home paths compactly", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(128_000), "128k");
	assert.equal(formatTokens(1_500_000), "1.5m");
	assert.ok(formatDirectory(process.env.HOME ?? "").startsWith("~"));
});

test("thinking text uses the corresponding editor border color", () => {
	assert.equal(thinkingColorToken("off"), "thinkingOff");
	assert.equal(thinkingColorToken("minimal"), "thinkingMinimal");
	assert.equal(thinkingColorToken("medium"), "thinkingMedium");
	assert.equal(thinkingColorToken("xhigh"), "thinkingXhigh");
	assert.equal(thinkingColorToken("max"), "thinkingMax");
});

test("extension statuses are flattened in stable footer order", () => {
	assert.deepEqual(
		extensionStatusValues(
			new Map([
				["zeta", "Z"],
				["alpha", "A\nB"],
				["empty", ""],
			]),
		),
		["A", "B", "Z"],
	);
});

test("pull request JSON accepts only open pull requests", () => {
	assert.deepEqual(
		parsePullRequestJson('{"number":42,"url":"https://github.com/a/b/pull/42","state":"OPEN","isDraft":false}'),
		{
			number: 42,
			url: "https://github.com/a/b/pull/42",
			isDraft: false,
		},
	);
	assert.equal(
		parsePullRequestJson('{"number":42,"url":"https://example.com","state":"CLOSED"}'),
		null,
	);
	assert.equal(parsePullRequestJson("not JSON"), null);
});

test("dashboard refreshes model state after its session reset", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	let footerFactory: ((tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] }) | undefined;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, listener: (value: unknown) => void) {
				const channel = listeners.get(name) ?? new Set();
				channel.add(listener);
				listeners.set(name, channel);
				return () => channel.delete(listener);
			},
			emit(name: string, value: unknown) {
				for (const listener of listeners.get(name) ?? []) listener(value);
			},
		},
		getThinkingLevel: () => "medium",
		exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	};
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		model: {
			provider: "openai-codex",
			id: "gpt-test",
			name: "GPT Test",
			reasoning: true,
			contextWindow: 128_000,
		},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 128_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			setHeader() {},
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
			setTitle() {},
		},
	};

	mepieUi(pi as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.ok(footerFactory);
	const footer = footerFactory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text },
		{ getExtensionStatuses: () => new Map([["codex-usage", "◷ 5h 73%"]]) },
	);
	const lines = footer.render(120);
	assert.equal(lines.length, 2);
	assert.match(lines.join("\n"), /openai-codex\/gpt-test · medium/);
	assert.match(lines[1] ?? "", /1%\/128k · \$0\.00 · — tok\/s · ◷ 5h 73%/);

	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
});

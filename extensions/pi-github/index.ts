import type {
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Container, Text } from "@earendil-works/pi-tui";
import { createGitHubAutocomplete } from "./autocomplete.ts";
import { createGitHubClient } from "./client.ts";
import {
	executeGitHub,
	type GitHubToolResult,
} from "./operations.ts";
import {
	GitHubParameters,
	type GitHubParameters as GitHubParametersType,
} from "./schema.ts";

type RenderState = {
	status?: "success" | "error";
	component?: Text;
};

function errorValue(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function updateHeader(
	args: GitHubParametersType,
	state: RenderState,
	theme: Theme,
): void {
	const target = "number" in args ? ` #${args.number}` : "";
	const marker = state.status === "success"
		? theme.fg("success", " ✓")
		: state.status === "error"
			? theme.fg("error", " ✗")
			: theme.fg("dim", " …");
	state.component?.setText(
		`${theme.fg("toolTitle", theme.bold("github"))}`
		+ `${theme.fg("muted", ` ${args.command}.${args.action}`)}`
		+ `${theme.fg("accent", target)}${marker}`,
	);
}

export default function piGitHub(pi: ExtensionAPI): void {
	const client = createGitHubClient(pi);

	pi.registerTool({
		name: "github",
		label: "GitHub",
		description: "Typed GitHub operations backed by gh. Use command and action to work with repositories, issues, pull requests, comments, and native child or blocked-by relations. Set repo to owner/name or omit it to use the repository for the current working directory.",
		parameters: GitHubParameters,
		async execute(_toolCallId, parameters, signal, _onUpdate, ctx): Promise<GitHubToolResult> {
			return Effect.runPromise(Effect.tryPromise({
				try: () => executeGitHub(client, parameters, signal, ctx),
				catch: errorValue,
			}), { signal }).catch((error: unknown) => {
				if (signal?.aborted) throw new Error("cancelled");
				throw error;
			});
		},
		renderCall(args, theme, context) {
			const state = context.state as RenderState;
			state.component = context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
			updateHeader(args, state, theme);
			return state.component;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as RenderState;
			if (!options.isPartial) {
				state.status = context.isError ? "error" : "success";
				updateHeader(context.args, state, theme);
			}
			if (!options.expanded) return new Container();

			const component = context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
			component.setText(resultText(result));
			return component;
		},
	});

	pi.on("session_start", (_event, ctx) => {
		client.reset();
		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider((current) => createGitHubAutocomplete(
			client,
			current,
			ctx.cwd,
			(message) => ctx.ui.notify(message, "warning"),
		));
	});
}

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ToolView } from "./tool-renderer.ts";

/** How a tool call made inside a codemode script is labeled. Codemode records only the call's arguments. */
export interface NestedToolView {
	readonly icon: string;
	readonly label: string;
	readonly targetColor: ThemeColor;
	readonly targetTruncation: "end" | "middle";
	target(args: Readonly<Record<string, unknown>>, cwd: string): string;
}

type NestedViewSource<TArgs> = Pick<ToolView<TArgs, unknown>, "icon" | "label" | "targetColor" | "targetTruncation" | "target">;

// Shared through globalThis like the spacing state, so file-search and mepie-tool-ui see one registry
// even when Pi loads their modules separately.
const NESTED_TOOL_VIEWS = Symbol.for("mepie.tool-ui.nested-views");

function nestedToolViews(): Map<string, NestedToolView> {
	const existing: unknown = Reflect.get(globalThis, NESTED_TOOL_VIEWS);
	if (existing instanceof Map) return existing;
	const views = new Map<string, NestedToolView>();
	Reflect.set(globalThis, NESTED_TOOL_VIEWS, views);
	return views;
}

/** Reuse a tool row's icon, label, and target for the same tool called from codemode. */
export function registerNestedToolView<TArgs>(name: string, view: NestedViewSource<TArgs>): void {
	nestedToolViews().set(name, {
		icon: view.icon,
		label: view.label,
		targetColor: view.targetColor ?? "muted",
		targetTruncation: view.targetTruncation ?? "middle",
		// The arguments are those the tool received, so they match its schema unless the call
		// failed validation. Codemode rendering guards target() against that case.
		target: (args, cwd) => view.target(args as Partial<TArgs>, cwd, true),
	});
}

export function nestedToolView(name: string): NestedToolView | undefined {
	return nestedToolViews().get(name);
}

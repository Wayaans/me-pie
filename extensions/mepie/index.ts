import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { CONFIGURABLE_EXTENSIONS, MEPIE_MANAGER_PATH } from "./catalog.ts";
import {
	findPackage,
	readGlobalStates,
	readProjectStates,
	updateGlobalPackage,
	updateProjectDelta,
	updateProjectPackage,
	type ProjectExtensionState,
} from "./config.ts";
import { changeToolRenderMode, loadToolRenderMode, TOOL_RENDER_MODES } from "./tool-mode.ts";

type Scope = "global" | "project";

const APPLY = "Apply changes";
const CANCEL = "Cancel";

interface MepieSourceInfo {
	readonly source: string;
	readonly scope: "user" | "project" | "temporary";
	readonly baseDir?: string;
}

function commandSource(pi: ExtensionAPI): MepieSourceInfo | undefined {
	return pi.getCommands().find((command) => {
		const path = command.sourceInfo.path.replaceAll("\\", "/");
		return command.source === "extension" && (path === MEPIE_MANAGER_PATH || path.endsWith(`/${MEPIE_MANAGER_PATH}`));
	})?.sourceInfo;
}

function isPortablePackageSource(source: string): boolean {
	return /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(source);
}

function findInstalledPackage(
	packages: readonly PackageSource[],
	sourceInfo: MepieSourceInfo,
	settingsBaseDir: string,
) {
	const exact = findPackage(packages, sourceInfo.source);
	if (exact || !sourceInfo.baseDir) return exact;
	for (const [index, entry] of packages.entries()) {
		const source = typeof entry === "string" ? entry : entry.source;
		const expanded = source === "~" ? homedir() : source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
		if (!isPortablePackageSource(source) && resolve(settingsBaseDir, expanded) === resolve(sourceInfo.baseDir)) {
			return { index, entry };
		}
	}
	return undefined;
}

function projectPackageSource(sourceInfo: MepieSourceInfo): string {
	return isPortablePackageSource(sourceInfo.source)
		? sourceInfo.source
		: sourceInfo.baseDir ?? sourceInfo.source;
}

function enabledIds(states: ReadonlyMap<string, boolean>): Set<string> {
	return new Set([...states].filter(([, enabled]) => enabled).map(([id]) => id));
}

function cycleProjectState(state: ProjectExtensionState): ProjectExtensionState {
	if (state === "inherit") return "enabled";
	if (state === "enabled") return "disabled";
	return "inherit";
}

async function chooseScope(
	ctx: ExtensionCommandContext,
	globalAvailable: boolean,
	projectAvailable: boolean,
): Promise<Scope | undefined> {
	const options = [
		...(globalAvailable ? ["Global"] : []),
		...(projectAvailable ? ["This project"] : []),
	];
	const selected = await ctx.ui.select("Configure Mepie extensions", options);
	if (selected === "Global") return "global";
	if (selected === "This project") return "project";
	return undefined;
}

async function editGlobalStates(
	ctx: ExtensionCommandContext,
	initial: ReadonlyMap<string, boolean>,
): Promise<Map<string, boolean> | undefined> {
	const states = new Map(initial);
	while (true) {
		const rows = CONFIGURABLE_EXTENSIONS.map((extension) => {
			const state = states.get(extension.id) ?? true;
			return `${state ? "[on] " : "[off]"} ${extension.id} · ${extension.description}`;
		});
		const selected = await ctx.ui.select("Mepie extensions · global", [...rows, APPLY, CANCEL]);
		if (selected === undefined || selected === CANCEL) return undefined;
		if (selected === APPLY) return states;
		const index = rows.indexOf(selected);
		const extension = CONFIGURABLE_EXTENSIONS[index];
		if (extension) states.set(extension.id, !(states.get(extension.id) ?? true));
	}
}

async function editProjectStates(
	ctx: ExtensionCommandContext,
	initial: ReadonlyMap<string, ProjectExtensionState>,
	globalStates: ReadonlyMap<string, boolean>,
): Promise<Map<string, ProjectExtensionState> | undefined> {
	const states = new Map(initial);
	while (true) {
		const rows = CONFIGURABLE_EXTENSIONS.map((extension) => {
			const state = states.get(extension.id) ?? "inherit";
			const inherited = globalStates.get(extension.id) === false ? "off" : "on";
			const label = state === "inherit" ? `inherit (${inherited})` : state;
			return `[${label}] ${extension.id} · ${extension.description}`;
		});
		const selected = await ctx.ui.select("Mepie extensions · this project", [...rows, APPLY, CANCEL]);
		if (selected === undefined || selected === CANCEL) return undefined;
		if (selected === APPLY) return states;
		const index = rows.indexOf(selected);
		const extension = CONFIGURABLE_EXTENSIONS[index];
		if (extension) states.set(extension.id, cycleProjectState(states.get(extension.id) ?? "inherit"));
	}
}

async function editProjectPackageStates(
	ctx: ExtensionCommandContext,
	initial: ReadonlyMap<string, boolean>,
): Promise<Map<string, boolean> | undefined> {
	const states = new Map(initial);
	while (true) {
		const rows = CONFIGURABLE_EXTENSIONS.map((extension) => {
			const state = states.get(extension.id) ?? true;
			return `${state ? "[on] " : "[off]"} ${extension.id} · ${extension.description}`;
		});
		const selected = await ctx.ui.select("Mepie extensions · project installation", [...rows, APPLY, CANCEL]);
		if (selected === undefined || selected === CANCEL) return undefined;
		if (selected === APPLY) return states;
		const index = rows.indexOf(selected);
		const extension = CONFIGURABLE_EXTENSIONS[index];
		if (extension) states.set(extension.id, !(states.get(extension.id) ?? true));
	}
}

async function saveAndReload(settings: SettingsManager, ctx: ExtensionCommandContext): Promise<void> {
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) throw errors[0]?.error ?? new Error("Failed to save Mepie settings.");
	await ctx.reload();
}

async function manageMepie(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/mepie requires TUI mode.", "error");
		return;
	}

	const sourceInfo = commandSource(pi);
	if (!sourceInfo) throw new Error("Could not determine the Mepie package source.");

	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const globalPackages: PackageSource[] = settings.getGlobalSettings().packages ?? [];
	const projectPackages: PackageSource[] = settings.getProjectSettings().packages ?? [];
	const globalLocation = findInstalledPackage(globalPackages, sourceInfo, getAgentDir());
	const projectLocation = findInstalledPackage(projectPackages, sourceInfo, join(ctx.cwd, CONFIG_DIR_NAME));

	if (!globalLocation && !projectLocation) {
		ctx.ui.notify("Mepie is loaded temporarily. Install it before changing extension settings.", "warning");
		return;
	}

	const scope = await chooseScope(
		ctx,
		globalLocation !== undefined,
		ctx.isProjectTrusted() && (globalLocation !== undefined || projectLocation !== undefined),
	);
	if (!scope) return;

	if (scope === "global") {
		if (!globalLocation) return;
		const changed = await editGlobalStates(ctx, readGlobalStates(globalLocation.entry));
		if (!changed) return;
		settings.setPackages(updateGlobalPackage(globalPackages, globalLocation, enabledIds(changed)));
		await saveAndReload(settings, ctx);
		return;
	}

	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Trust this project before writing project extension settings.", "warning");
		return;
	}

	const projectIsDelta = projectLocation === undefined
		|| (typeof projectLocation.entry !== "string" && projectLocation.entry.autoload === false);
	if (globalLocation && projectIsDelta) {
		const globalStates = readGlobalStates(globalLocation.entry);
		const changed = await editProjectStates(ctx, readProjectStates(projectLocation?.entry), globalStates);
		if (!changed) return;
		const source = projectLocation
			? (typeof projectLocation.entry === "string" ? projectLocation.entry : projectLocation.entry.source)
			: projectPackageSource(sourceInfo);
		settings.setProjectPackages(updateProjectDelta(projectPackages, source, changed));
		await saveAndReload(settings, ctx);
		return;
	}

	if (!projectLocation) return;
	const changed = await editProjectPackageStates(ctx, readGlobalStates(projectLocation.entry));
	if (!changed) return;
	settings.setProjectPackages(updateProjectPackage(projectPackages, projectLocation, enabledIds(changed)));
	await saveAndReload(settings, ctx);
}

export default function mepie(pi: ExtensionAPI): void {
	const activeMode = loadToolRenderMode(pi);
	pi.registerCommand("mepie", {
		description: "Manage Mepie extensions and tool rendering",
		getArgumentCompletions(prefix) {
			const choices = ["tool", ...TOOL_RENDER_MODES.map((mode) => `tool ${mode}`)];
			const items = choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: (args, ctx) => Effect.runPromise(
			Effect.tryPromise({
				try: () => {
					if (args.trim().split(/\s+/)[0] === "tool") return changeToolRenderMode(args, activeMode, ctx);
					if (args.trim()) {
						if (ctx.hasUI) ctx.ui.notify("Usage: /mepie or /mepie tool compact|builtin|simple|custom", "error");
						return Promise.resolve();
					}
					return manageMepie(pi, ctx);
				},
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}),
		),
	});
}

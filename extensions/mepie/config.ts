import { matchesGlob } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { CONFIGURABLE_EXTENSIONS, MEPIE_MANAGER_PATH, type MepieExtension } from "./catalog.ts";

export type ProjectExtensionState = "inherit" | "enabled" | "disabled";

export interface PackageLocation {
	readonly index: number;
	readonly entry: PackageSource;
}

function packageSource(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

export function findPackage(packages: readonly PackageSource[], source: string): PackageLocation | undefined {
	const index = packages.findIndex((entry) => packageSource(entry) === source);
	const entry = packages[index];
	return index < 0 || entry === undefined ? undefined : { index, entry };
}

function packagePatterns(entry: PackageSource): readonly string[] | undefined {
	return typeof entry === "string" ? undefined : entry.extensions;
}

function normalizePattern(pattern: string): string {
	return pattern.startsWith("./") ? pattern.slice(2) : pattern;
}

function patternParts(pattern: string): { pattern: string; kind: "include" | "exclude" | "force-include" | "force-exclude" } {
	if (pattern.startsWith("+")) return { pattern: normalizePattern(pattern.slice(1)), kind: "force-include" };
	if (pattern.startsWith("-")) return { pattern: normalizePattern(pattern.slice(1)), kind: "force-exclude" };
	if (pattern.startsWith("!")) return { pattern: normalizePattern(pattern.slice(1)), kind: "exclude" };
	return { pattern: normalizePattern(pattern), kind: "include" };
}

function matches(path: string, pattern: string, exact: boolean): boolean {
	return exact ? path === pattern : matchesGlob(path, pattern);
}

export function isEnabledByPackageEntry(entry: PackageSource, extension: MepieExtension): boolean {
	const patterns = packagePatterns(entry);
	if (patterns === undefined) return true;
	if (patterns.length === 0) return false;

	const parsed = patterns.map(patternParts);
	const includes = parsed.filter(({ kind }) => kind === "include");
	let enabled = includes.length === 0 || includes.some(({ pattern }) => matches(extension.path, pattern, false));
	if (parsed.some(({ kind, pattern }) => kind === "exclude" && matches(extension.path, pattern, false))) enabled = false;
	if (parsed.some(({ kind, pattern }) => kind === "force-include" && matches(extension.path, pattern, true))) enabled = true;
	if (parsed.some(({ kind, pattern }) => kind === "force-exclude" && matches(extension.path, pattern, true))) enabled = false;
	return enabled;
}

export function readGlobalStates(entry: PackageSource): Map<string, boolean> {
	return new Map(CONFIGURABLE_EXTENSIONS.map((extension) => [extension.id, isEnabledByPackageEntry(entry, extension)]));
}

export function readProjectStates(entry: PackageSource | undefined): Map<string, ProjectExtensionState> {
	const states = new Map<string, ProjectExtensionState>(CONFIGURABLE_EXTENSIONS.map((extension) => [extension.id, "inherit"]));
	if (entry === undefined || typeof entry === "string" || entry.autoload !== false) return states;

	for (const rawPattern of entry.extensions ?? []) {
		const { pattern, kind } = patternParts(rawPattern);
		const enabled = kind === "include" || kind === "force-include";
		const exact = kind === "force-include" || kind === "force-exclude";
		for (const extension of CONFIGURABLE_EXTENSIONS) {
			if (matches(extension.path, pattern, exact)) states.set(extension.id, enabled ? "enabled" : "disabled");
		}
	}
	return states;
}

function replacePackage(packages: readonly PackageSource[], location: PackageLocation, replacement: PackageSource): PackageSource[] {
	return packages.map((entry, index) => index === location.index ? replacement : entry);
}

function asFilteredEntry(entry: PackageSource, extensions: string[], autoload?: false): Exclude<PackageSource, string> {
	return {
		...(typeof entry === "string" ? { source: entry } : entry),
		...(autoload === false ? { autoload: false as const } : {}),
		extensions,
	};
}

export function updateGlobalPackage(
	packages: readonly PackageSource[],
	location: PackageLocation,
	enabledIds: ReadonlySet<string>,
): PackageSource[] {
	const patterns = [
		`+${MEPIE_MANAGER_PATH}`,
		...CONFIGURABLE_EXTENSIONS.filter(({ id }) => !enabledIds.has(id)).map(({ path }) => `-${path}`),
	];
	return replacePackage(packages, location, asFilteredEntry(location.entry, patterns));
}

export function updateProjectDelta(
	packages: readonly PackageSource[],
	source: string,
	states: ReadonlyMap<string, ProjectExtensionState>,
): PackageSource[] {
	const location = findPackage(packages, source);
	const extensions = [
		`+${MEPIE_MANAGER_PATH}`,
		...CONFIGURABLE_EXTENSIONS.flatMap(({ id, path }) => {
			const state = states.get(id) ?? "inherit";
			if (state === "inherit") return [];
			return [`${state === "enabled" ? "+" : "-"}${path}`];
		}),
	];
	if (location === undefined) return [...packages, { source, autoload: false, extensions }];
	return replacePackage(packages, location, asFilteredEntry(location.entry, extensions, false));
}

export function updateProjectPackage(
	packages: readonly PackageSource[],
	location: PackageLocation,
	enabledIds: ReadonlySet<string>,
): PackageSource[] {
	const patterns = [
		`+${MEPIE_MANAGER_PATH}`,
		...CONFIGURABLE_EXTENSIONS.filter(({ id }) => !enabledIds.has(id)).map(({ path }) => `-${path}`),
	];
	const base = typeof location.entry === "string"
		? { source: location.entry }
		: Object.fromEntries(Object.entries(location.entry).filter(([key]) => key !== "autoload"));
	return replacePackage(packages, location, { ...base, extensions: patterns } as Exclude<PackageSource, string>);
}

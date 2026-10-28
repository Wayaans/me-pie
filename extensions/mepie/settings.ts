import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** One `mepie.json` per scope. Each feature owns and validates its own top-level key. */
export type MepieSettings = Record<string, unknown>;

export function globalSettingsPath(agentDir = getAgentDir()): string {
	return join(agentDir, "mepie.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mepie.json");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing files are empty settings. Malformed files throw so callers never overwrite them. */
export function readSettings(path: string): MepieSettings {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error(`Cannot read ${path}: expected a JSON object.`);
	return value;
}

/** Atomically replaces the file with `update(current)`, preserving keys owned by other features. */
export function updateSettings(path: string, update: (current: MepieSettings) => MepieSettings): void {
	const next = update(readSettings(path));
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.mepie-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			// Already renamed into place.
		}
	}
}

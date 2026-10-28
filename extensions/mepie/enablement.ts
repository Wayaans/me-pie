import { isMepieExtensionId, MEPIE_EXTENSIONS, type MepieExtensionId } from "./catalog.ts";
import { isRecord, type MepieSettings } from "./settings.ts";

/** Explicit per-scope choices from the `extensions` key. Missing ids have no opinion. */
export type ExtensionChoices = ReadonlyMap<MepieExtensionId, boolean>;

export function parseExtensionChoices(settings: MepieSettings): Map<MepieExtensionId, boolean> {
	const section = settings.extensions;
	if (section === undefined) return new Map();
	if (!isRecord(section)) throw new Error("extensions must be an object of extension ids to true or false.");
	const choices = new Map<MepieExtensionId, boolean>();
	for (const [id, enabled] of Object.entries(section)) {
		if (!isMepieExtensionId(id)) {
			throw new Error(`Unknown extension "${id}". Choose from ${MEPIE_EXTENSIONS.map((extension) => extension.id).join(", ")}.`);
		}
		if (typeof enabled !== "boolean") throw new Error(`extensions.${id} must be true or false.`);
		choices.set(id, enabled);
	}
	return choices;
}

/** Global `false` wins everywhere; otherwise the project choice applies; otherwise the extension is on. */
export function isExtensionEnabled(id: MepieExtensionId, global: ExtensionChoices, project: ExtensionChoices): boolean {
	if (global.get(id) === false) return false;
	return project.get(id) ?? true;
}

/** Store only disabled ids so the file stays minimal and defaults remain implicit. */
export function withExtensionChoices(settings: MepieSettings, disabled: ReadonlySet<MepieExtensionId>): MepieSettings {
	const { extensions: _previous, ...rest } = settings;
	void _previous;
	if (disabled.size === 0) return rest;
	const extensions = Object.fromEntries(
		MEPIE_EXTENSIONS.filter(({ id }) => disabled.has(id)).map(({ id }) => [id, false]),
	);
	return { ...rest, extensions };
}

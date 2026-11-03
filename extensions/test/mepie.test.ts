import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectTrustStore, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MepieExtensionId } from "../mepie/catalog.ts";
import { isExtensionEnabled, parseExtensionChoices, withExtensionChoices } from "../mepie/enablement.ts";
import { loadEnabledExtensions } from "../mepie/loader.ts";
import { registerMepieCommand } from "../mepie/manager.ts";
import { globalSettingsPath, projectSettingsPath } from "../mepie/settings.ts";

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
}

function choices(entries: Record<string, boolean>) {
	return parseExtensionChoices({ extensions: entries });
}

test("global disable wins over every project choice", () => {
	const global = choices({ webweb: false, "ask-me": true });
	assert.equal(isExtensionEnabled("webweb", global, choices({ webweb: true })), false);
	assert.equal(isExtensionEnabled("ask-me", global, choices({ "ask-me": false })), false);
	assert.equal(isExtensionEnabled("ask-me", global, new Map()), true);
	assert.equal(isExtensionEnabled("localize", new Map(), new Map()), true);
});

test("extension settings reject unknown ids and non-boolean values", () => {
	assert.throws(() => choices({ webwbe: false }), /Unknown extension "webwbe"/);
	assert.throws(() => parseExtensionChoices({ extensions: { webweb: "off" } }), /extensions\.webweb must be true or false/);
	assert.throws(() => parseExtensionChoices({ extensions: [] }), /extensions must be an object/);
});

test("saving extension choices keeps other settings and stores only disabled ids", () => {
	const settings = { localize: { thinking: "low" }, extensions: { "ask-me": true, webweb: false } };
	assert.deepEqual(withExtensionChoices(settings, new Set(["localize"])), { localize: { thinking: "low" }, extensions: { localize: false } });
	assert.deepEqual(withExtensionChoices(settings, new Set()), { localize: { thinking: "low" } });
});

function fakeExtensions(loaded: string[]) {
	const ids: MepieExtensionId[] = ["ask-me", "localize", "webweb"];
	return ids.map((id) => ({
		id,
		load: async () => ({
			default: () => {
				if (id === "localize") throw new Error("boom");
				loaded.push(id);
			},
		}),
	}));
}

test("loader applies global and project settings and isolates failing extensions", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "mepie-loader-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "mepie-loader-project-"));
	writeJson(globalSettingsPath(agentDir), { extensions: { webweb: false } });
	writeJson(projectSettingsPath(cwd), { extensions: { webweb: true, "ask-me": false } });

	const loaded: string[] = [];
	const pi = {} as ExtensionAPI;
	const warnings = await loadEnabledExtensions(pi, { cwd, agentDir, extensions: fakeExtensions(loaded) });
	assert.deepEqual(loaded, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /could not load localize: boom/);

	// An explicitly distrusted project cannot change which extensions load.
	new ProjectTrustStore(agentDir).set(cwd, false);
	loaded.length = 0;
	await loadEnabledExtensions(pi, { cwd, agentDir, extensions: fakeExtensions(loaded) });
	assert.deepEqual(loaded, ["ask-me"]);
});

test("loader warns and ignores malformed settings", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "mepie-loader-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "mepie-loader-project-"));
	mkdirSync(dirname(globalSettingsPath(agentDir)), { recursive: true });
	writeFileSync(globalSettingsPath(agentDir), "{broken");
	writeJson(projectSettingsPath(cwd), { extensions: { nope: false } });

	const loaded: string[] = [];
	const warnings = await loadEnabledExtensions({} as ExtensionAPI, { cwd, agentDir, extensions: fakeExtensions(loaded) });
	assert.deepEqual(loaded, ["ask-me", "webweb"]);
	assert.equal(warnings.filter((warning) => warning.startsWith("Ignoring Mepie extension settings")).length, 2);
});

test("project manager locks globally disabled extensions and preserves their project choice", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "mepie-manager-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "mepie-manager-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeJson(globalSettingsPath(agentDir), { extensions: { webweb: false } });
		writeJson(projectSettingsPath(cwd), { localize: { thinking: "low" }, extensions: { webweb: false } });

		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		registerMepieCommand({ registerCommand: (_name, value) => { command = value; } });
		assert.ok(command);

		const picks = ["This project", "webweb", "ask-me", "Apply changes"];
		const notices: string[] = [];
		let reloaded = false;
		const ctx = {
			cwd,
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				notify: (message: string) => notices.push(message),
				select: async (_title: string, options: string[]) => {
					const pick = picks.shift();
					return options.find((option) => option === pick || option.includes(` ${pick} ·`));
				},
			},
			reload: async () => { reloaded = true; },
		} as unknown as ExtensionCommandContext;
		await command.handler("", ctx);

		assert.match(notices[0] ?? "", /webweb is disabled globally/);
		assert.equal(reloaded, true);
		assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath(cwd), "utf8")), {
			localize: { thinking: "low" },
			extensions: { "ask-me": false, webweb: false },
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

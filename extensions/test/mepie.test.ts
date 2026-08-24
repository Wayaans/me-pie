import assert from "node:assert/strict";
import test from "node:test";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { CONFIGURABLE_EXTENSIONS, MEPIE_MANAGER_PATH } from "../mepie/catalog.ts";
import {
	findPackage,
	isEnabledByPackageEntry,
	readGlobalStates,
	readProjectStates,
	updateGlobalPackage,
	updateProjectDelta,
	updateProjectPackage,
	type ProjectExtensionState,
} from "../mepie/config.ts";

const source = "/packages/mepie";
const answer = CONFIGURABLE_EXTENSIONS.find(({ id }) => id === "answer")!;
const terminal = CONFIGURABLE_EXTENSIONS.find(({ id }) => id === "terminal-environment")!;

test("package filters resolve includes, exclusions, and force overrides", () => {
	const entry: PackageSource = {
		source,
		extensions: ["extensions/*/index.ts", "!extensions/terminal-*/index.ts", "+extensions/terminal-environment/index.ts", "-extensions/answer/index.ts"],
	};
	assert.equal(isEnabledByPackageEntry(entry, answer), false);
	assert.equal(isEnabledByPackageEntry(entry, terminal), true);
});

test("global update keeps unrelated package filters and pins the manager", () => {
	const packages: PackageSource[] = [
		"npm:other",
		{ source, skills: ["skills/*"], themes: [], extensions: ["extensions/*/index.ts"] },
	];
	const location = findPackage(packages, source)!;
	const updated = updateGlobalPackage(packages, location, new Set(["answer"]));
	assert.equal(updated[0], "npm:other");
	const entry = updated[1];
	assert.equal(typeof entry, "object");
	assert.deepEqual(typeof entry === "object" ? entry.skills : undefined, ["skills/*"]);
	assert.deepEqual(typeof entry === "object" ? entry.themes : undefined, []);
	assert.ok(typeof entry === "object" && entry.extensions?.includes(`+${MEPIE_MANAGER_PATH}`));
	assert.ok(typeof entry === "object" && !entry.extensions?.includes(`-${answer.path}`));
	assert.ok(typeof entry === "object" && entry.extensions?.includes(`-${terminal.path}`));
	assert.deepEqual([...readGlobalStates(entry!)].filter(([, enabled]) => enabled).map(([id]) => id), ["answer"]);
});

test("project delta stores inherit, enabled, and disabled independently", () => {
	const states = new Map<string, ProjectExtensionState>(CONFIGURABLE_EXTENSIONS.map(({ id }) => [id, "inherit"]));
	states.set("answer", "enabled");
	states.set("terminal-environment", "disabled");
	const updated = updateProjectDelta([], source, states);
	assert.deepEqual(updated, [{
		source,
		autoload: false,
		extensions: [
		`+${MEPIE_MANAGER_PATH}`,
		`+${answer.path}`,
		`-${terminal.path}`,
	],
	}]);
	assert.equal(readProjectStates(updated[0]).get("answer"), "enabled");
	assert.equal(readProjectStates(updated[0]).get("terminal-environment"), "disabled");
	assert.equal(readProjectStates(updated[0]).get("ask-me"), "inherit");
});

test("project delta updates preserve filters for other resource types", () => {
	const packages: PackageSource[] = [{ source, autoload: false, skills: ["+skills/unslop/SKILL.md"], extensions: [] }];
	const states = new Map([["answer", "disabled" as const]]);
	const updated = updateProjectDelta(packages, source, states);
	assert.deepEqual(updated[0], {
		source,
		autoload: false,
		skills: ["+skills/unslop/SKILL.md"],
		extensions: [`+${MEPIE_MANAGER_PATH}`, `-${answer.path}`],
	});
});

test("project-only package update removes delta mode and keeps the manager", () => {
	const packages: PackageSource[] = [{ source, autoload: false, prompts: [], extensions: [] }];
	const location = findPackage(packages, source)!;
	const updated = updateProjectPackage(packages, location, new Set(["answer"]));
	const entry = updated[0];
	assert.equal(typeof entry, "object");
	assert.deepEqual(typeof entry === "object" ? entry.prompts : undefined, []);
	assert.ok(typeof entry === "object" && entry.extensions?.includes(`+${MEPIE_MANAGER_PATH}`));
	assert.ok(typeof entry === "object" && !entry.extensions?.includes(`-${answer.path}`));
	assert.ok(typeof entry === "object" && entry.extensions?.includes(`-${terminal.path}`));
});

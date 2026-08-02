import assert from "node:assert/strict";
import test from "node:test";
import { createSkillShortcutInputHandler, extractDollarPrefix, transformSkillShortcuts } from "../skill-shortcut/index.ts";

test("skill-shortcut transforms known dollar skill tokens", () => {
	assert.equal(transformSkillShortcuts("$diagnose this failure", ["diagnose"]), "/skill:diagnose this failure");
	assert.equal(
		transformSkillShortcuts("please $requesting-code-review after changes", ["requesting-code-review"]),
		"please /skill:requesting-code-review after changes",
	);
});

test("skill-shortcut preserves whitespace and unknown dollar tokens", () => {
	assert.equal(transformSkillShortcuts("  $diagnose\n", ["diagnose"]), "  /skill:diagnose\n");
	assert.equal(transformSkillShortcuts("$unknown and $diagnose", ["diagnose"]), "$unknown and /skill:diagnose");
});

test("skill-shortcut extracts the dollar token at the cursor", () => {
	assert.equal(extractDollarPrefix("$diag"), "$diag");
	assert.equal(extractDollarPrefix("please $diag"), "$diag");
	assert.equal(extractDollarPrefix("please diagnose"), null);
	assert.equal(extractDollarPrefix("please $diag now"), null);
});

test("skill-shortcut input handler uses the latest skill list", () => {
	let skills = ["diagnose"];
	const handler = createSkillShortcutInputHandler(() => skills);

	assert.deepEqual(handler({ text: "$diagnose" }), { action: "transform", text: "/skill:diagnose" });

	skills = ["requesting-code-review"];
	assert.deepEqual(handler({ text: "$requesting-code-review" }), {
		action: "transform",
		text: "/skill:requesting-code-review",
	});
});

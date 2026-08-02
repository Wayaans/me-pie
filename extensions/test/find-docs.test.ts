import assert from "node:assert/strict";
import test from "node:test";
import {
	extractContext7LibraryId,
	formatFindDocsSummary,
	formatFindDocsTarget,
	isCtx7Bash,
} from "../find-docs/utils.ts";

test("find-docs extracts Context7 library ids from resolver output", () => {
	assert.equal(extractContext7LibraryId("Best match: /facebook/react"), "/facebook/react");
	assert.equal(extractContext7LibraryId("no library here"), undefined);
});

test("find-docs formats collapsed call targets", () => {
	assert.equal(
		formatFindDocsTarget({ library: "react", query: "useEffect cleanup" }),
		"react • useEffect cleanup",
	);
	assert.equal(formatFindDocsTarget({ libraryId: "/vercel/next.js", query: "routing" }), "/vercel/next.js • routing");
});

test("find-docs formats collapsed result summaries", () => {
	assert.equal(
		formatFindDocsSummary({ libraryId: "/facebook/react", query: "hooks", resolved: true }),
		"/facebook/react • hooks",
	);
	assert.equal(formatFindDocsSummary({ library: "react", resolved: false }), "react • no Context7 match");
	assert.equal(formatFindDocsSummary(undefined), "");
});

test("find-docs detects ctx7 bash invocations", () => {
	assert.equal(isCtx7Bash("ctx7 docs /facebook/react hooks"), true);
	assert.equal(isCtx7Bash("npx ctx7@latest library react hooks"), true);
	assert.equal(isCtx7Bash("npm run docs"), false);
});

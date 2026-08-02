import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { Effect } from "effect";
import { installNotifications, makeBinaryInitializers } from "../file-search/index.ts";
import {
	FD_DEFAULT_LIMIT,
	buildFdArgs,
	buildRgArgs,
	normalizeSearchPath,
} from "../file-search/src/args.ts";
import {
	InstallError,
	TOOL_SPECS,
	releaseAsset,
	resolveBinary,
	type BinaryEnv,
	type ReleaseAsset,
	type ResolvedBinary,
} from "../file-search/src/binaries.ts";
import { formatOutput } from "../file-search/src/output.ts";

function makeEnvironment(options: { available?: string[]; failInstall?: boolean } = {}) {
	const installed = new Set<string>();
	const installs: ReleaseAsset[] = [];
	const environment: BinaryEnv = {
		probe: (command) =>
			Effect.sync(() => options.available?.includes(command) === true || installed.has(command)),
		install: (asset, destination) => {
			if (options.failInstall) {
				return Effect.fail(new InstallError({ message: "network down" }));
			}
			return Effect.sync(() => {
				installs.push(asset);
				installed.add(destination);
			});
		},
	};
	return { environment, installs };
}

const darwinArm = { os: "darwin", arch: "arm64" } as const;

test("fd constructs safe arguments and normalizes paths", () => {
	assert.deepEqual(
		buildFdArgs({ pattern: "-rf", path: "@src", extension: ".ts", hidden: true, limit: 50 }),
		[
			"--color=never",
			"--hidden",
			"--extension",
			"ts",
			"--max-results",
			"50",
			"--",
			"-rf",
			"src",
		],
	);
	assert.deepEqual(buildFdArgs({}), [
		"--color=never",
		"--max-results",
		String(FD_DEFAULT_LIMIT),
		"--",
		"",
	]);
	assert.equal(normalizeSearchPath("~"), homedir());
	assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
});

test("rg uses smart case and keeps patterns behind the option separator", () => {
	assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
		"--line-number",
		"--color=never",
		"--no-heading",
		"--with-filename",
		"--smart-case",
		"--max-count",
		"100",
		"--",
		"--help",
	]);
});

test("binary resolution prefers the system and accepts Debian fdfind", async () => {
	const { environment, installs } = makeEnvironment({ available: ["fdfind"] });
	const resolved = await Effect.runPromise(
		resolveBinary(TOOL_SPECS.fd, "/cache", darwinArm, environment),
	);
	assert.deepEqual(resolved, { tool: "fd", command: "fdfind", source: "system" });
	assert.equal(installs.length, 0);
});

test("missing binaries are installed from verified release metadata", async () => {
	const { environment, installs } = makeEnvironment();
	const resolved = await Effect.runPromise(
		resolveBinary(TOOL_SPECS.rg, "/cache", darwinArm, environment),
	);
	assert.equal(resolved.source, "installed");
	assert.equal(installs.length, 1);
	assert.match(installs[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
});

test("one failed initializer does not disable the other tool", async () => {
	const { environment } = makeEnvironment({ available: ["rg"], failInstall: true });
	const initializers = makeBinaryInitializers("/cache", darwinArm, environment);
	await assert.rejects(Effect.runPromise(initializers.fd), /network down/);
	assert.deepEqual(await Effect.runPromise(initializers.rg), {
		tool: "rg",
		command: "rg",
		source: "system",
	});
});

test("release metadata supports macOS and Linux on arm64 and x64", () => {
	for (const os of ["darwin", "linux"] as const) {
		for (const arch of ["arm64", "x64"] as const) {
			for (const tool of ["fd", "rg"] as const) {
				const asset = releaseAsset(tool, { os, arch });
				assert.ok(asset);
				assert.match(asset.url, /^https:\/\//);
				assert.match(asset.sha256, /^[a-f0-9]{64}$/);
			}
		}
	}
});

test("only freshly installed binaries produce notifications", () => {
	const binaries: ResolvedBinary[] = [
		{ tool: "fd", command: "fd", source: "system" },
		{ tool: "rg", command: "/cache/rg", source: "installed", version: "15.2.0" },
	];
	assert.equal(installNotifications(binaries).length, 1);
});

test("large output is truncated and its complete form is persisted", async () => {
	const output = Array.from({ length: 3_000 }, (_, index) => `file-${index}.ts`).join("\n");
	let persisted = "";
	const formatted = await formatOutput(output, {
		tempPrefix: "mepie-fd-test-",
		persistFullOutput: async (full) => {
			persisted = full;
			return "/tmp/mepie-search/output.txt";
		},
	});
	assert.equal(persisted, output);
	assert.equal(formatted.truncated, true);
	assert.match(formatted.text, /2000 of 3000 lines/);
	assert.equal(formatted.fullOutputPath, "/tmp/mepie-search/output.txt");
});

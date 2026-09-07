// Use the installed Pi runtime's jiti and peer packages, not a global TS runner.
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { fileURLToPath } = require("node:url");

async function main() {
	const piRequire = createRequire(process.argv[2]);
	const { createJiti } = piRequire("jiti");
	const resolver = createJiti(process.argv[2]);
	const alias = {};
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox", "typebox/value"]) {
		alias[name] = fileURLToPath(resolver.esmResolve(name));
	}
	const jiti = createJiti(__filename, { alias, moduleCache: false });
	const { bridgeMain } = await jiti.import(join(__dirname, "bridge-runtime.ts"));
	await bridgeMain();
}

// stderr is deliberately unused. Neither jiti nor a network exception may print
// inherited configuration or token URLs. Clients report bounded, redacted errors.
main().catch(() => { process.exitCode = 1; });

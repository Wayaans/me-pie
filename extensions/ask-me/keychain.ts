import { spawn } from "node:child_process";

const SERVICE = "mepie.ask-me.telegram";
export class KeychainError extends Error {
	override readonly name = "KeychainError";
	constructor() { super("ask_me Keychain operation failed or was cancelled. Check macOS Keychain permissions and retry. No raw Keychain output is shown."); }
}
export const validToken = (token: string): boolean => token.length <= 256 && /^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token);
export const validReference = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export type PrivateProcess = (executable: string, args: readonly string[], input: string | undefined, signal: AbortSignal) => Promise<string>;

/** Pipe-only I/O, bounded output/lifetime, no inherited debug environment and no raw subprocess errors. */
export function privateProcess(executable: string, args: readonly string[], input: string | undefined, signal: AbortSignal, deadlineMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new KeychainError()); return; }
		const child = spawn(executable, [...args], { stdio: ["pipe", "pipe", "pipe"], env: {}, shell: false });
		let output = "";
		let failed = false;
		let settled = false;
		const finish = (success: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (success && !failed) resolve(output); else reject(new KeychainError());
			output = "";
		};
		const abort = () => { failed = true; child.kill("SIGKILL"); finish(false); };
		const timer = setTimeout(abort, deadlineMs);
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", () => finish(false));
		child.stdin.on("error", abort);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 4096) abort();
		});
		// Discard stderr rather than retaining security's descriptions or command text.
		child.stderr.resume();
		child.on("close", (code) => finish(code === 0));
		child.stdin.end(input);
		if (signal.aborted) abort();
	});
}

export async function writeToken(reference: string, token: string, signal: AbortSignal, run: PrivateProcess = privateProcess, platform = process.platform): Promise<void> {
	if (platform !== "darwin" || !validReference(reference) || !validToken(token)) throw new KeychainError();
	try {
		// Apple's security -i reads commands from stdin without echo/history. Never use -v.
		// Strict alphabets above exclude quoting, newlines and command injection. No -U:
		// replacements always create a fresh item and cannot overwrite a shared credential.
		await run("/usr/bin/security", ["-i", "-q"], `add-generic-password -a ${reference} -s ${SERVICE} -T "" -w ${token}\n`, signal);
	} catch { throw new KeychainError(); }
}

export async function readToken(reference: string, signal: AbortSignal, run: PrivateProcess = privateProcess, platform = process.platform): Promise<string> {
	if (platform !== "darwin" || !validReference(reference)) throw new KeychainError();
	try {
		const token = (await run("/usr/bin/security", ["find-generic-password", "-a", reference, "-s", SERVICE, "-w"], undefined, signal)).trim();
		if (!validToken(token)) throw new KeychainError();
		return token;
	} catch { throw new KeychainError(); }
}

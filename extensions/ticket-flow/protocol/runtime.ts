import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerIdentity } from "../domain.ts";
import { ProtocolClient, type ProtocolClientOptions } from "./client.ts";

/** A short, per-run socket path kept outside the checkout and below Unix limits. */
export function workflowSocketPath(runId: string, temporaryDirectory = process.env.TMPDIR ?? os.tmpdir()): string {
	const safe = runId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 32);
	if (!safe) throw new Error("Workflow run ID cannot produce a socket path");
	return path.join(temporaryDirectory, "mepie-ticket-flow", `${safe}.sock`);
}

/** Never store this value in run JSON or events; it lives beside global run state. */
export function workflowTokenPath(runDirectory: string): string { return path.join(runDirectory, ".native-protocol-token"); }
export function writeWorkflowToken(runDirectory: string, token: string): Effect.Effect<void, Error> {
	const file = workflowTokenPath(runDirectory);
	return Effect.tryPromise({
		try: async () => { await mkdir(runDirectory, { recursive: true, mode: 0o700 }); await chmod(runDirectory, 0o700); await writeFile(file, token, { encoding: "utf8", mode: 0o600, flag: "wx" }); await chmod(file, 0o600); },
		catch: (cause) => new Error(`Could not create secure workflow token file: ${cause instanceof Error ? cause.message : String(cause)}`),
	});
}
export function readWorkflowToken(runDirectory: string): Effect.Effect<string, Error> {
	const file = workflowTokenPath(runDirectory);
	return Effect.tryPromise({
		try: async () => {
			const metadata = await stat(file); const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (uid !== undefined && metadata.uid !== uid)) throw new Error("token file is not owner-only");
			const token = await readFile(file, "utf8"); if (!token || /[\0\r\n]/.test(token)) throw new Error("token file contents are invalid"); return token;
		},
		catch: (cause) => new Error(`Could not read secure workflow token file: ${cause instanceof Error ? cause.message : String(cause)}`),
	});
}
export function removeWorkflowToken(runDirectory: string): Effect.Effect<void> { return Effect.promise(() => rm(workflowTokenPath(runDirectory), { force: true }).catch(() => undefined)); }

export function workerIdentityFromContext(context: Pick<ExtensionContext, "model" | "thinkingLevel" | "sessionManager">, runId: string, workItemId: string): WorkerIdentity {
	if (!context.model || !context.thinkingLevel) throw new Error("Ticket Flow worker requires Pi's actual provider, model, and thinking level at session start.");
	const sessionFile = context.sessionManager.getSessionFile();
	return {
		runId, workItemId, provider: context.model.provider, model: context.model.id, thinking: context.thinkingLevel,
		...(context.sessionManager.getSessionId() === undefined ? {} : { sessionId: context.sessionManager.getSessionId() }),
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
}

export class WorkerProtocolRuntime {
	private client: ProtocolClient | undefined;
	start(options: ProtocolClientOptions): Effect.Effect<ProtocolClient> {
		const runtime = this;
		return Effect.gen(function* () {
			const client = new ProtocolClient(options);
			yield* client.start();
			runtime.client = client;
			return client;
		});
	}
	shutdown(): Effect.Effect<void> { const client = this.client; this.client = undefined; return client?.shutdown() ?? Effect.void; }
}

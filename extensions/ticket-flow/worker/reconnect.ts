import path from "node:path";

export const DEFAULT_WORKER_RECONNECT_DELAYS_MS = [50, 100, 250, 500, 1_000] as const;

/**
 * Recovery recreates the persisted socket path, so the worker can safely use a
 * stable resolver without reading mutable state from the project checkout.
 */
export class WorkerSocketReconnect {
	constructor(private readonly persistedSocketPath: string) {
		if (!path.isAbsolute(persistedSocketPath)) throw new Error("Worker reconnect socket path must be absolute.");
	}

	path(): string { return this.persistedSocketPath; }

	delay(attempt: number, configured?: readonly number[]): number {
		const delays = configured ?? DEFAULT_WORKER_RECONNECT_DELAYS_MS;
		return delays[Math.min(Math.max(0, attempt), delays.length - 1)] ?? 1_000;
	}
}

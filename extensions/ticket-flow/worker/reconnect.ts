import path from "node:path";

export const DEFAULT_WORKER_RECONNECT_DELAYS_MS = [50, 100, 250, 500, 1_000] as const;

/** Recovery recreates this persisted path; workers never consult project state. */
export function validateWorkerReconnectPath(socketPath: string): string {
	if (!path.isAbsolute(socketPath)) throw new Error("Worker reconnect socket path must be absolute.");
	return socketPath;
}

export function workerReconnectDelay(attempt: number, configured?: readonly number[]): number {
	const delays = configured ?? DEFAULT_WORKER_RECONNECT_DELAYS_MS;
	return delays[Math.min(Math.max(0, attempt), delays.length - 1)] ?? 1_000;
}

import type { AssignmentKind, SerializedWorkerHandle, WorkerProfile } from "../model.ts";

export interface BackendIdentity {
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
}

export interface SpawnInput {
	readonly cwd: string;
	readonly runId: string;
	readonly assignmentId: string;
	readonly operationId: string;
	readonly title: string;
	readonly profile: WorkerProfile;
	readonly kind: AssignmentKind;
	readonly socketPath: string;
	readonly token: string;
	readonly backendIdentity?: BackendIdentity;
	readonly sessionFile?: string;
}

export type WorkerInspection =
	| { readonly state: "alive" | "exited" | "missing" }
	| { readonly state: "foreign" | "ambiguous"; readonly message: string };

export interface WorkerBackend {
	validate(signal?: AbortSignal): Promise<void>;
	identify?(signal?: AbortSignal): Promise<BackendIdentity>;
	spawn(input: SpawnInput, signal?: AbortSignal): Promise<SerializedWorkerHandle>;
	inspect(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<WorkerInspection>;
	reopen(input: SpawnInput & { readonly sessionFile: string }, signal?: AbortSignal): Promise<SerializedWorkerHandle>;
	abort(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<void>;
	close(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<void>;
	/** Close a crash-created window found only by the durable launch intent. */
	closeLaunchIntent?(identity: Pick<SpawnInput, "runId" | "assignmentId" | "operationId" | "backendIdentity">, signal?: AbortSignal): Promise<void>;
}

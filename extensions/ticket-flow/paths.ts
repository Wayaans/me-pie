import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { PersistenceError, ValidationError } from "./errors.ts";

export interface WorkflowPaths {
	readonly canonicalProjectPath: string;
	readonly projectId: string;
	readonly agentDir: string;
	readonly rootDir: string;
	readonly projectDir: string;
	readonly runDir: string;
	readonly stateFile: string;
	readonly planFile: string;
	readonly eventsFile: string;
	readonly reportsDir: string;
}

export interface CanonicalPathService {
	readonly realpath: (input: string) => Promise<string>;
}

export const nodeCanonicalPathService: CanonicalPathService = { realpath };

export function projectIdFromCanonicalPath(canonicalProjectPath: string): string {
	return createHash("sha256").update(canonicalProjectPath).digest("hex");
}

export function canonicalizeProjectPath(
	projectPath: string,
	service: CanonicalPathService = nodeCanonicalPathService,
): Effect.Effect<string, PersistenceError> {
	const resolved = path.resolve(projectPath);
	return Effect.tryPromise({
		try: () => service.realpath(resolved),
		catch: (cause) => new PersistenceError({ operation: "canonicalize project path", path: resolved, cause }),
	});
}

function canonicalizeAllowMissing(
	input: string,
	service: CanonicalPathService,
): Effect.Effect<string, PersistenceError> {
	const resolved = path.resolve(input);
	return Effect.tryPromise({
		try: async () => {
			const missing: string[] = [];
			let existing = resolved;
			while (true) {
				try {
					const canonical = await service.realpath(existing);
					return path.join(canonical, ...missing.reverse());
				} catch (cause) {
					const parent = path.dirname(existing);
					if (parent === existing) throw cause;
					missing.push(path.basename(existing));
					existing = parent;
				}
			}
		},
		catch: (cause) => new PersistenceError({ operation: "canonicalize agent path", path: resolved, cause }),
	});
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkflowPaths(
	canonicalProjectPath: string,
	runId: string,
	agentDir = getAgentDir(),
	service: CanonicalPathService = nodeCanonicalPathService,
): Effect.Effect<WorkflowPaths, ValidationError | PersistenceError> {
	return Effect.gen(function* () {
		const canonicalProject = yield* canonicalizeProjectPath(canonicalProjectPath, service);
		const resolvedAgentDir = yield* canonicalizeAllowMissing(agentDir, service);
		const rootDir = path.join(resolvedAgentDir, "state", "ticket-flow");
		if (isWithin(canonicalProject, rootDir)) {
			return yield* Effect.fail(new ValidationError({
				message: "Ticket Flow global state directory must not be inside the project",
				path: rootDir,
			}));
		}
		if (!runId.trim() || runId === "." || runId === ".." || path.basename(runId) !== runId) {
			return yield* Effect.fail(new ValidationError({ message: "run ID must be a stable path-safe identifier", path: "runId" }));
		}
		const projectId = projectIdFromCanonicalPath(canonicalProject);
		const projectDir = path.join(rootDir, projectId);
		const runDir = path.join(projectDir, runId);
		return {
			canonicalProjectPath: canonicalProject,
			projectId,
			agentDir: resolvedAgentDir,
			rootDir,
			projectDir,
			runDir,
			stateFile: path.join(runDir, "state.json"),
			planFile: path.join(runDir, "plan.json"),
			eventsFile: path.join(runDir, "events.jsonl"),
			reportsDir: path.join(runDir, "reports"),
		};
	});
}

export function pathsForProject(
	projectPath: string,
	runId: string,
	agentDir = getAgentDir(),
	service: CanonicalPathService = nodeCanonicalPathService,
): Effect.Effect<{ readonly canonicalProjectPath: string; readonly paths: WorkflowPaths }, PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const canonicalProjectPath = yield* canonicalizeProjectPath(projectPath, service);
		const paths = yield* resolveWorkflowPaths(canonicalProjectPath, runId, agentDir, service);
		return { canonicalProjectPath, paths };
	});
}

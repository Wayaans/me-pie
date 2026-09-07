import { Effect, Exit } from "effect";

export const PAGE_BODY_LIMIT = 5 * 1024 * 1024;
export const PROVIDER_BODY_LIMIT = 10 * 1024 * 1024;

export class BodyLimitError extends Error {
	constructor(limit: number) {
		super(`Response exceeds ${limit} byte limit`);
		this.name = "BodyLimitError";
	}
}

/** Race even operations that do not implement AbortSignal, including DNS lookup. */
export function abortable<A>(operation: Promise<A>, signal: AbortSignal): Promise<A> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}

/** Dispose a late response even if an injected fetch ignores cancellation. */
export function awaitResponse(operation: Promise<Response>, signal: AbortSignal): Promise<Response> {
	return abortable(operation.then((response) => {
		if (signal.aborted) {
			void response.body?.cancel().catch(() => {});
			signal.throwIfAborted();
		}
		return response;
	}), signal);
}

/** Bound decoded bytes, not Content-Length. Cancel unfinished bodies on every exit. */
export async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		signal.throwIfAborted();
		return new Uint8Array();
	}
	let complete = false;
	try {
		signal.throwIfAborted();
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > limit) throw new BodyLimitError(limit);
		const chunks: Array<Uint8Array> = [];
		let size = 0;
		while (true) {
			const next = await abortable(reader.read(), signal);
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new BodyLimitError(limit);
			chunks.push(next.value);
		}
		complete = true;
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export async function readText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
	const bytes = await readBody(response, limit, signal);
	const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
	let decoder: TextDecoder;
	try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
	return decoder.decode(bytes);
}

/** External cancellation is interruption, never a retryable provider failure. */
export function withAbort<A, E, R>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal): Effect.Effect<A, E, R> {
	if (!signal) return effect;
	return Effect.suspend(() => {
		if (signal.aborted) return Effect.interrupt;
		const aborted = Effect.callback<never>((resume) => {
			const abort = () => resume(Effect.interrupt);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			return Effect.sync(() => signal.removeEventListener("abort", abort));
		});
		const guarded = effect.pipe(
			Effect.flatMap((value) => signal.aborted ? Effect.interrupt : Effect.succeed(value)),
			Effect.catchCause((cause) => signal.aborted ? Effect.interrupt : Effect.failCause(cause)),
		);
		return Effect.raceFirst(guarded, aborted);
	});
}

/** Collect ordinary failures without turning interruption or defects into partial success. */
export function settle<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Exit.Exit<A, E>, never, R> {
	return Effect.match(effect, { onSuccess: Exit.succeed, onFailure: Exit.fail });
}

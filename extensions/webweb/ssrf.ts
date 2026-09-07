import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type RequestOptions, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { SsrfBlockedError } from "./errors.ts";
import { abortable, BodyLimitError, PAGE_BODY_LIMIT, readBody, readText } from "./network.ts";

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
export type LookupFunction = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: LookupFunction = (hostname, options) => lookup(hostname, options);

function ipv4Number(ip: string): number {
	return ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function ipv6Number(ip: string): bigint {
	let normalized = ip.toLowerCase();
	if (normalized.includes(".")) {
		const colon = normalized.lastIndexOf(":");
		const v4 = ipv4Number(normalized.slice(colon + 1));
		normalized = `${normalized.slice(0, colon)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
	}
	const halves = normalized.split("::");
	const left = (halves[0] ?? "").split(":").filter(Boolean);
	const right = (halves[1] ?? "").split(":").filter(Boolean);
	const parts = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
	return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}

export function isReservedIp(ip: string): boolean {
	const family = isIP(ip);
	if (ip.includes("%") || !family) return true;
	if (family === 4) {
		const value = ipv4Number(ip);
		const ranges: ReadonlyArray<readonly [string, number]> = [
			["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
			["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
			["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
			["203.0.113.0", 24], ["224.0.0.0", 3],
		];
		return ranges.some(([base, prefix]) => Math.floor(value / 2 ** (32 - prefix)) === Math.floor(ipv4Number(base) / 2 ** (32 - prefix)));
	}
	const value = ipv6Number(ip);
	// Accept only IANA allocations to regional registries, not merely 2000::/3.
	// This excludes reserved/unallocated space, mapped IPv4, NAT64 and transition
	// mechanisms such as Teredo and 6to4. Review when IANA adds an allocation:
	// https://www.iana.org/assignments/ipv6-unicast-address-assignments (2025-10-10)
	const allocations: ReadonlyArray<readonly [string, number]> = [
		["2001:200::", 23], ["2001:400::", 23], ["2001:600::", 23], ["2001:800::", 22],
		["2001:c00::", 23], ["2001:e00::", 23], ["2001:1200::", 23], ["2001:1400::", 22],
		["2001:1800::", 23], ["2001:1a00::", 23], ["2001:1c00::", 22], ["2001:2000::", 19],
		["2001:4000::", 23], ["2001:4200::", 23], ["2001:4400::", 23], ["2001:4600::", 23],
		["2001:4800::", 23], ["2001:4a00::", 23], ["2001:4c00::", 23], ["2001:5000::", 20],
		["2001:8000::", 19], ["2001:a000::", 20], ["2001:b000::", 20], ["2003::", 18],
		["2400::", 12], ["2410::", 12], ["2600::", 12], ["2610::", 23], ["2620::", 23],
		["2630::", 12], ["2800::", 12], ["2a00::", 12], ["2a10::", 12], ["2c00::", 12],
	];
	if (value >> 96n === ipv6Number("2001:db8::") >> 96n) return true;
	return !allocations.some(([base, prefix]) => value >> BigInt(128 - prefix) === ipv6Number(base) >> BigInt(128 - prefix));
}

async function resolveRemoteUrl(rawUrl: string, options: { lookup?: LookupFunction | undefined; signal?: AbortSignal | undefined }) {
	const signal = options.signal ?? AbortSignal.timeout(60_000);
	signal.throwIfAborted();
	let parsed: URL;
	try { parsed = new URL(rawUrl); } catch {
		throw new SsrfBlockedError({ message: "Invalid remote URL" });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SsrfBlockedError({ message: "Only http and https URLs are allowed" });
	if (parsed.username || parsed.password) throw new SsrfBlockedError({ message: "Blocked URL with embedded credentials" });
	if (!ALLOWED_PORTS.has(parsed.port)) throw new SsrfBlockedError({ message: `Blocked URL port ${parsed.port}` });
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	let addresses: Array<{ address: string; family: number }>;
	try {
		const family = isIP(hostname);
		addresses = family ? [{ address: hostname, family }] : await abortable((options.lookup ?? defaultLookup)(hostname, { all: true, verbatim: true }), signal);
	} catch {
		signal.throwIfAborted();
		throw new SsrfBlockedError({ message: "Remote DNS resolution failed" });
	}
	const address = addresses[0];
	if (!address || addresses.some((entry) => isReservedIp(entry.address) || isIP(entry.address) !== entry.family)) {
		throw new SsrfBlockedError({ message: "Blocked request to private or reserved address" });
	}
	return { parsed, address };
}

export async function validateRemoteUrl(rawUrl: string, options: { lookup?: LookupFunction | undefined; signal?: AbortSignal | undefined } = {}): Promise<URL> {
	return (await resolveRemoteUrl(rawUrl, options)).parsed;
}

export type RequestFunction = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface GuardedFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: Headers;
	readonly url: string;
	readonly arrayBuffer: () => Promise<ArrayBuffer>;
	readonly text: () => Promise<string>;
	readonly cancel: () => void;
}

export interface GuardedFetchInit {
	method?: string | undefined;
	headers?: Record<string, string> | undefined;
	signal?: AbortSignal | undefined;
	lookup?: LookupFunction | undefined;
	/** Offline connector seam. Production always uses node:http or node:https. */
	request?: RequestFunction | undefined;
}

async function requestPinned(url: URL, address: { address: string; family: number }, init: GuardedFetchInit, signal: AbortSignal): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = init.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
		const req = request(url, {
			method: init.method ?? "GET",
			// Disable connection reuse so every connection uses this validated address.
			agent: false,
			headers: { ...init.headers, Host: url.host, "Accept-Encoding": "gzip, deflate, br" },
			signal,
			lookup: (_hostname, options, callback) => {
				if (options.all) callback(null, [address]);
				else callback(null, address.address, address.family);
			},
		}, (incoming) => {
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (Array.isArray(value)) for (const item of value) headers.append(name, item);
				else if (value !== undefined) headers.set(name, value);
			}
			const status = incoming.statusCode ?? 502;
			if (status >= 300 && status < 400 || status === 204 || status === 205 || init.method === "HEAD") {
				incoming.destroy();
				resolve(new Response(null, { status, headers }));
				return;
			}
			let size = 0;
			const wireLimit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
				size += chunk.length;
				callback(size > PAGE_BODY_LIMIT ? new BodyLimitError(PAGE_BODY_LIMIT) : null, chunk);
			} });
			const encoding = headers.get("content-encoding")?.toLowerCase();
			const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
			if (encoding && encoding !== "identity" && !decoder) {
				incoming.destroy();
				reject(new Error("Unsupported response content encoding"));
				return;
			}
			const body = decoder ?? wireLimit;
			if (decoder) {
				headers.delete("content-encoding");
				headers.delete("content-length");
				pipeline(incoming, wireLimit, decoder, () => {});
			} else pipeline(incoming, wireLimit, () => {});
			const iterator = body[Symbol.asyncIterator]();
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = await iterator.next();
						if (next.done) { controller.close(); return; }
						const chunk: unknown = next.value;
						if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected HTTP body chunk");
						controller.enqueue(chunk);
					} catch (error) { controller.error(error); }
				},
				cancel() { body.destroy(); incoming.destroy(); },
			});
			resolve(new Response(stream, { status, headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** Every redirect resolves once, validates every answer, and pins the connection. */
export async function guardedFetch(rawUrl: string, init: GuardedFetchInit = {}): Promise<GuardedFetchResponse> {
	const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]);
	let currentUrl = rawUrl;
	let headers = init.headers;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const { parsed, address } = await resolveRemoteUrl(currentUrl, { lookup: init.lookup, signal });
		signal.throwIfAborted();
		const response = await requestPinned(parsed, address, { ...init, headers }, signal);
		if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
			void response.body?.cancel().catch(() => {});
			const next = new URL(response.headers.get("location") ?? "", parsed);
			if (next.origin !== parsed.origin && headers) {
				headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(authorization|proxy-authorization|cookie)$/i.test(name)));
			}
			currentUrl = next.href;
			continue;
		}
		return {
			ok: response.ok, status: response.status, headers: response.headers, url: parsed.href,
			cancel: () => { void response.body?.cancel().catch(() => {}); },
			arrayBuffer: async () => { const bytes = await readBody(response, PAGE_BODY_LIMIT, signal); return bytes.slice().buffer; },
			text: () => readText(response, PAGE_BODY_LIMIT, signal),
		};
	}
	throw new SsrfBlockedError({ message: `Too many redirects (more than ${MAX_REDIRECTS})` });
}

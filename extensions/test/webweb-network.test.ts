import { describe, expect, test } from "bun:test";
import { createServer, request, type Server } from "node:http";
import { createServer as createTlsServer, request as tlsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect, Exit } from "effect";
import { guardedFetch, isReservedIp, validateRemoteUrl, type LookupFunction, type RequestFunction } from "../webweb/ssrf.ts";
import { awaitResponse, BodyLimitError, PAGE_BODY_LIMIT, PROVIDER_BODY_LIMIT, readBody } from "../webweb/network.ts";
import { firecrawlSearch, firecrawlScrape, type FetchLike } from "../webweb/firecrawl.ts";
import { openaiSearch } from "../webweb/openai.ts";
import { fetchTopPages, runSearch, runVerify } from "../webweb/search.ts";
import { runFetch } from "../webweb/fetch.ts";

const publicLookup: LookupFunction = async () => [{ address: "93.184.216.34", family: 4 }];
const config = { firecrawlApiKey: "fc-offline-secret", openaiApiKey: "sk-offline-secret", firecrawlApiVersion: "v2" as const, firecrawlBaseUrl: "https://custom.example", openaiSearchModel: "offline" };
const firecrawl = { apiKey: config.firecrawlApiKey, apiVersion: "v2" as const, baseUrl: config.firecrawlBaseUrl };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return address.port;
}
async function close(server: Server) {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	});
}

/** Only the test connector maps the validated public address onto its loopback server. */
function localConnector(port: number, seen: Array<string>, ca?: string): RequestFunction {
	return (url, options, callback) => {
		const lookup = options.lookup;
		if (!lookup) throw new Error("Production transport did not pin DNS");
		expect(options.agent).toBe(false);
		return (ca ? tlsRequest : request)(url, {
			...options, port, ...(ca ? { ca } : {}),
			lookup(hostname, lookupOptions, done) {
				lookup(hostname, { ...lookupOptions, all: false }, (error, address) => {
					if (error) { done(error, "", 4); return; }
					if (typeof address !== "string") throw new Error("Expected pinned address");
					seen.push(`${hostname}=${address}`);
					if (lookupOptions.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
					else done(null, "127.0.0.1", 4);
				});
			},
		}, callback);
	};
}

function oversized(limit: number, cancelled: () => void): Response {
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(new Uint8Array(Math.min(limit, 64 * 1024))); },
		cancel: cancelled,
	}));
}

async function interrupted(effect: Effect.Effect<unknown, unknown>) {
	const exit = await Effect.runPromiseExit(effect);
	expect(Exit.isFailure(exit)).toBe(true);
	if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Interrupt")).toBe(true);
}

describe("public address validation", () => {
	for (const ip of ["0.0.0.0", "10.1.1.1", "100.64.0.1", "127.1.2.3", "169.254.2.3", "172.31.1.2", "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.19.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "100::1", "2000::1", "2001::1", "2001:db8::1", "2002:7f00:1::", "2004::1", "2d00::1", "3000::1", "3ffe::1", "3fff::1", "fc00::1", "fe80::1", "fec0::1", "ff02::1"]) {
		test(`rejects ${ip}`, () => expect(isReservedIp(ip)).toBe(true));
	}
	test("allows ordinary public addresses", () => {
		for (const ip of ["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111", "2410::1", "2a10::1"]) expect(isReservedIp(ip)).toBe(false);
	});
	test("rejects canonicalized mapped and unusual numeric loopback URLs", async () => {
		for (const url of ["http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]", "http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "http://user:secret@public.example"]) await expect(validateRemoteUrl(url)).rejects.toThrow();
	});
	test("rejects mixed public/private DNS answers", async () => {
		await expect(validateRemoteUrl("https://public.example", { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }] })).rejects.toThrow();
	});
	test("abort interrupts stalled DNS without opening a connection", async () => {
		const controller = new AbortController();
		const pending = guardedFetch("https://public.example", { lookup: () => new Promise(() => {}), signal: controller.signal, request: () => { throw new Error("Must not connect"); } });
		controller.abort();
		await expect(pending).rejects.toThrow();
	});
});

describe("pinned native HTTP", () => {
	test("pins the sole resolution, keeps Host, decodes gzip and blocks private redirects", async () => {
		const seen: Array<string> = [];
		const hosts: Array<string | undefined> = [];
		const server = createServer((req, res) => {
			hosts.push(req.headers.host);
			if (req.url === "/redirect") { res.writeHead(302, { location: "http://[::ffff:127.0.0.1]/private" }); res.end(); return; }
			res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1", "content-encoding": "gzip" });
			res.end(gzipSync(Buffer.from([0x63, 0x61, 0x66, 0xe9])));
		});
		const port = await listen(server);
		try {
			let resolutions = 0;
			const lookup: LookupFunction = async () => { resolutions++; return publicLookup("", { all: true, verbatim: true }); };
			const connector = localConnector(port, seen);
			const response = await guardedFetch("http://public.example/page", { lookup, request: connector });
			expect(await response.text()).toBe("café");
			expect(resolutions).toBe(1);
			expect(seen).toEqual(["public.example=93.184.216.34"]);
			expect(hosts).toEqual(["public.example"]);
			await expect(guardedFetch("http://public.example/redirect", { lookup, request: connector })).rejects.toThrow("private or reserved");
			expect(hosts).toHaveLength(2);
		} finally { await close(server); }
	});

	test("keeps original TLS hostname and certificate verification with pinned DNS", async () => {
		const dir = await mkdtemp(join(tmpdir(), "webweb-tls-"));
		let server: Server | undefined;
		try {
			const keyPath = join(dir, "key.pem");
			const certPath = join(dir, "cert.pem");
			execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=public.example", "-addext", "subjectAltName=DNS:public.example"], { stdio: "ignore", timeout: 10_000 });
			const cert = await readFile(certPath, "utf8");
			server = createTlsServer({ key: await readFile(keyPath), cert }, (_req, res) => res.end("tls ok"));
			const port = await listen(server);
			const seen: Array<string> = [];
			const connector = localConnector(port, seen, cert);
			expect(await (await guardedFetch("https://public.example", { lookup: publicLookup, request: connector })).text()).toBe("tls ok");
			await expect(guardedFetch("https://wrong.example", { lookup: publicLookup, request: connector })).rejects.toThrow();
			expect(seen[0]).toBe("public.example=93.184.216.34");
		} finally {
			try { if (server) await close(server); } finally { await rm(dir, { recursive: true, force: true }); }
		}
	});

	test("closes a streaming page on overflow and abort", async () => {
		let closed = 0;
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1);
			res.on("close", () => { closed++; clearInterval(timer); });
		});
		const port = await listen(server);
		try {
			const connector = localConnector(port, []);
			const response = await guardedFetch("http://public.example", { lookup: publicLookup, request: connector });
			await expect(response.text()).rejects.toThrow("byte limit");
			const controller = new AbortController();
			const second = await guardedFetch("http://public.example", { lookup: publicLookup, request: connector, signal: controller.signal });
			const body = second.text(); controller.abort();
			await expect(body).rejects.toThrow();
			await pause(30);
			expect(closed).toBe(2);
		} finally { await close(server); }
	});
});

describe("bounded body consumption", () => {
	test("cancels a late response from a fetch implementation that ignores abort", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const request = new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }))), 10));
		const pending = awaitResponse(request, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		await pause(20); expect(cancelled).toBe(true);
	});
	test("bounds streaming bytes and cancels on overflow, length rejection and abort", async () => {
		let cancellations = 0;
		await expect(readBody(oversized(1024, () => cancellations++), 1024, new AbortController().signal)).rejects.toBeInstanceOf(BodyLimitError);
		const declared = oversized(1024, () => cancellations++);
		declared.headers.set("content-length", "2048");
		await expect(readBody(declared, 1024, new AbortController().signal)).rejects.toBeInstanceOf(BodyLimitError);
		const controller = new AbortController();
		const pending = readBody(new Response(new ReadableStream({ cancel() { cancellations++; } })), 1024, controller.signal);
		controller.abort(); await expect(pending).rejects.toThrow();
		expect(cancellations).toBe(3);
		expect(PAGE_BODY_LIMIT).toBe(5 * 1024 * 1024);
	});
});

describe("provider containment", () => {
	test("custom deployment key never reaches an alternate host", async () => {
		const targets: Array<string> = [];
		const fetchLike: FetchLike = async (url) => { targets.push(String(url)); throw new Error("connect failed"); };
		await Effect.runPromiseExit(firecrawlSearch("q", { numResults: 1 }, { ...firecrawl, fetchLike }));
		expect(targets).toHaveLength(3);
		expect(targets.every((url) => url.startsWith("https://custom.example/"))).toBe(true);
	});
	test("provider redirects and oversize bodies are terminal with no fallback", async () => {
		for (const kind of ["redirect", "oversize"] as const) {
			let calls = 0; let cancelled = false;
			const fetchLike: FetchLike = async (_url, init) => {
				calls++; expect(init?.redirect).toBe("manual");
				return kind === "oversize" ? oversized(PROVIDER_BODY_LIMIT, () => { cancelled = true; }) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "https://evil.example" } });
			};
			const exit = await Effect.runPromiseExit(runSearch({ query: "q" }, { config, fetchLike }));
			expect(Exit.isFailure(exit)).toBe(true); expect(calls).toBe(1); expect(cancelled).toBe(true);
		}
	});
	test("OpenAI redirects and oversized responses do not retry", async () => {
		for (const kind of ["redirect", "oversize"] as const) {
			let calls = 0; let cancelled = false;
			const fetchLike: FetchLike = async (_url, init) => {
				calls++; expect(init?.redirect).toBe("manual");
				return kind === "oversize" ? oversized(PROVIDER_BODY_LIMIT, () => { cancelled = true; }) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "https://evil.example" } });
			};
			const exit = await Effect.runPromiseExit(openaiSearch("q", { numResults: 1 }, { apiKey: config.openaiApiKey, model: "offline", fetchLike }));
			expect(Exit.isFailure(exit)).toBe(true); expect(calls).toBe(1); expect(cancelled).toBe(true);
		}
	});
	test("scrape validates targets before sending to hosted provider", async () => {
		let calls = 0;
		const fetchLike: FetchLike = async () => { calls++; return new Response("{}"); };
		const exit = await Effect.runPromiseExit(firecrawlScrape("http://[::ffff:127.0.0.1]", { ...firecrawl, fetchLike }));
		expect(Exit.isFailure(exit)).toBe(true); expect(calls).toBe(0);
	});
	test("redacts parsed errors, success=false messages and thrown failures", async () => {
		for (const provider of ["firecrawl", "openai"] as const) {
			const key = provider === "firecrawl" ? config.firecrawlApiKey : config.openaiApiKey;
			for (const kind of ["http", "unsuccessful", "throw"] as const) {
				const fetchLike: FetchLike = async () => {
					if (kind === "throw") throw new Error(`failed with ${key}`);
					return Response.json({ success: false, error: `bad ${key} ${"x".repeat(1000)}` }, { status: kind === "http" ? 401 : 200 });
				};
				const effect: Effect.Effect<unknown, Error> = provider === "firecrawl" ? firecrawlSearch("q", { numResults: 1 }, { ...firecrawl, fetchLike }) : openaiSearch("q", { numResults: 1 }, { apiKey: key, model: "offline", fetchLike });
				const exit = await Effect.runPromiseExit(effect);
				expect(JSON.stringify(exit)).not.toContain(key);
				if (Exit.isFailure(exit)) for (const reason of exit.cause.reasons) if (reason._tag === "Fail") expect(String(reason.error).length).toBeLessThan(400);
			}
		}
	});
});

describe("cancellation is interruption", () => {
	test("direct OpenAI calls honor abort before, during request and during backoff", async () => {
		for (const when of ["before", "request", "backoff"] as const) {
			const controller = new AbortController(); let calls = 0;
			if (when === "before") controller.abort();
			const fetchLike: FetchLike = async (_url, init) => {
				calls++; expect(init?.signal).toBeDefined();
				setTimeout(() => controller.abort(), 10);
				return when === "request" ? new Promise(() => {}) : Response.json({ error: "busy" }, { status: 503 });
			};
			await interrupted(openaiSearch("q", { numResults: 1 }, { apiKey: config.openaiApiKey, model: "offline", fetchLike }, controller.signal));
			await pause(220); expect(calls).toBe(when === "before" ? 0 : 1);
		}
	});
	test("runtime interruption survives partial-page aggregation", async () => {
		const controller = new AbortController();
		const fetchLike: FetchLike = async () => { setTimeout(() => controller.abort(), 5); return new Promise(() => {}); };
		const effect = fetchTopPages([{ url: "https://public.example" }], { config, fetchLike, lookup: publicLookup }, config);
		const exit = await Effect.runPromiseExit(effect, { signal: controller.signal });
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Interrupt")).toBe(true);
	});
	test("pre-aborted search, fetch and verify do not call providers or cache", async () => {
		const controller = new AbortController(); controller.abort();
		let calls = 0;
		const deps = { config, signal: controller.signal, fetchLike: async () => { calls++; throw new Error("Must not fetch"); } };
		await interrupted(runSearch({ query: "q" }, deps));
		await interrupted(runFetch({ url: "https://public.example" }, deps));
		await interrupted(runVerify({ claim: "q" }, deps));
		expect(calls).toBe(0);
	});
	test("in-flight provider and page aggregation abort without fallback or dropped-page success", async () => {
		for (const pages of [false, true]) {
			const controller = new AbortController(); let calls = 0; let aborted = false;
			const fetchLike: FetchLike = async (_url, init) => {
				calls++; init?.signal?.addEventListener("abort", () => { aborted = true; });
				setTimeout(() => controller.abort(), 5);
				return new Promise(() => {});
			};
			const deps = { config, signal: controller.signal, fetchLike, lookup: publicLookup };
			await interrupted(pages ? fetchTopPages([{ url: "https://public.example" }], deps, config) : runSearch({ query: "q" }, deps));
			expect(calls).toBe(1); expect(aborted).toBe(true);
		}
	});
	test("abort during backoff prevents retries and provider fallback", async () => {
		const controller = new AbortController(); let calls = 0;
		const fetchLike: FetchLike = async () => { calls++; setTimeout(() => controller.abort(), 20); return Response.json({ error: "busy" }, { status: 503 }); };
		await interrupted(runSearch({ query: "q" }, { config, signal: controller.signal, fetchLike }));
		await pause(250); expect(calls).toBe(1);
	});
});

# `online_search` / `online_fetch` architecture analysis and implementation plan

## Scope and recommendation

Build a new `extensions/online-web/index.ts` extension with exactly two public tools:

- `online_search`: Firecrawl Search first; OpenAI Responses `web_search` using Pi's Codex auth as fallback.
- `online_fetch`: Firecrawl Scrape for one URL. Do **not** pretend that Codex search is an exact URL fetch fallback: if Firecrawl is ineligible or fails, return a typed, actionable error rather than silently returning a search answer for the page.

Keep the provider adapters independent of Pi and put one Effect 4 program behind each tool boundary. This is smaller and safer than importing the broad `pi-web-access` workflow (which includes many providers, curation, browser UI, video, PDF, GitHub, and a fourth retrieval tool).

## Primary sources examined

| Source | Architecture evidence |
|---|---|
| `/tmp/pi-github-repos/davis7dotsh/my-pi-setup@main/extensions/firecrawl-search/index.ts` | Firecrawl SDK client/key resolution (`L33-L108`), bounded output/temp-file persistence (`L116-L133`), crawl resource cancellation (`L141-L175`), one Effect-to-Pi Promise boundary (`L189-L231`), and schemas/registration for search and scrape (`L234-L421`). |
| Same checkout: `index.test.ts`, `package.json` | Tests inject a minimal `CrawlClient` and prove interruption calls `cancelCrawl` (`index.test.ts:L6-L36`); output tests prove 2,000-line truncation and complete persistence (`index.test.ts:L135-L148`). The extension has its own `package.json`/`package-lock.json`, uses `firecrawl`, Effect beta.99, and keeps TypeScript as a jiti-loaded entry point. |
| `/tmp/pi-github-repos/nicobailon/pi-web-access/openai-search.ts` | Codex/OpenAI auth and model selection (`L168-L230`), request construction (`L403-L452`), JSON/SSE parsing and citation extraction (`L271-L400`), and credential-redacted errors (`L454-L483`). |
| Same checkout: `firecrawl.ts`, `extract.ts`, `ssrf-protection.ts` | Config/API-version/credential handling and Firecrawl scrape envelope validation (`firecrawl.ts:L40-L142`, `L202-L278`); target and API-endpoint SSRF/redirect validation (`firecrawl.ts:L160-L190`, `ssrf-protection.ts:L180-L244`); fallback routing and non-recoverable error policy (`extract.ts`, `extractContent` provider loop around `L390-L620`). |
| Same checkout: `index.ts`, `storage.ts`, tests | Tool registration/schema and cancellation (`index.ts:L1604-L1644`, `L2286-L2361`, `L1607-L1618`); 30,000-character inline fetch slice (`L558-L588`, `L2394-L2452`); private cache plus bounded session metadata (`storage.ts:L8-L13`, `L123-L153`, `L175-L232`); routing, provider-precedence, Firecrawl, storage, and SSRF tests listed below. |
| Current Mepie | `AGENTS.md:L7-L38` requires Bun, strict TypeScript, Effect 4, jiti/no build, nested extension entry points, abort handling, Pi limits, and branch-safe state. `package.json:L22-L58` uses root Bun scripts, Effect `4.0.0-beta.102`, and `./extensions/*/index.ts`. `extensions/file-search/index.ts:L82-L119`, `L189-L248` and `extensions/test/file-search.test.ts:L135-L148` are the representative typed-error, `Exit`, abort, details, and truncation conventions. |

## What to reuse and what to avoid

**Reuse:** Davis's small operation pipeline and explicit operation status, `Effect.runPromiseExit`, `Cause.hasInterruptsOnly`, `Data.TaggedError`, `truncateHead`, and temp-file notice. Its crawl bracket is a good resource-safety pattern even though crawl is out of scope. Reuse the idea of injectable provider clients from `index.test.ts`, not the SDK's global behavior.

**Reuse from `pi-web-access`:** the Codex auth algorithm and response normalization; `credential-source.ts` semantics (literal config, `$NAME`/`${NAME}`, `!command`, bounded command output and redaction); Firecrawl's strict `success`/`data.markdown` validation; local DNS validation before submitting a URL; manual redirect validation and cross-origin credential stripping; cache files with `0700` directory/`0600` files and only bounded metadata in session entries. Its tests are unusually valuable regression cases: `test/provider-precedence.test.mjs`, `test/search-routing.test.mjs`, `test/firecrawl-extraction.test.mjs`, `test/fetch-cache-storage.test.mjs`, `test/fetch-answer-storage.test.mjs`, `test/ssrf-protection.test.mjs`, `test/ssrf-allow-ranges-config.test.mjs`, `test/fetch-routing.test.mjs`, and `test/tool-registration-config.test.mjs`.

**Avoid:** Davis registering generic `search`, `scrape`, and `crawl` names (`index.ts:L234-L280`), because this feature's contract is exactly `online_search` and `online_fetch`; Davis's hand-rolled `~/.pi/agent/.env` parser (`L33-L66`) should not become a second credential/config system; its SDK client does not provide the self-hosted-base-URL, redirect, or SSRF controls needed here. Avoid `pi-web-access`'s monolithic `index.ts`, broad provider loop, background fetches, interactive curator, and hidden `get_search_content` tool. Avoid its string-only error/fallback heuristics: the new extension must classify typed failures before deciding whether fallback is safe.

## Provider flows

### Firecrawl primary

Use a narrow `FirecrawlClient` interface backed by direct `fetch` (rather than coupling the core to the SDK):

- `search(input, signal): Effect<SearchResponse, WebError>` -> `POST {baseUrl}/{version}/search` with `{ query, limit, sources: [source], scrapeOptions?: { formats: ["markdown"], onlyMainContent: true } }`.
- `scrape(input, signal): Effect<ScrapeDocument, WebError>` -> `POST {baseUrl}/{version}/scrape` with `{ url, formats: ["markdown"], onlyMainContent: true, waitFor?, timeout? }`.
- Default hosted base: `https://api.firecrawl.dev`; default version: `v2`; allow `v1` for older self-hosted deployments. Validate the base URL before every request, and validate `success === true`, object `data`, and string `markdown` before mapping output.
- Normalize Firecrawl search results into `{ title, url, snippet, source?, publishedAt? }`, deduplicate by normalized URL, and retain the raw provider name in `details` only. `scrapeResults` may request markdown in search results, but the model-facing output should remain bounded.
- `online_fetch` validates the target URL locally, submits it to Firecrawl, chooses `metadata.title` then `title`, and returns trimmed markdown. Empty markdown is a successful no-content result only if the response shape is valid; it is not a reason to call Codex.

Firecrawl's official endpoint references are [Search](https://docs.firecrawl.dev/api-reference/endpoint/search) and [Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape). The official [Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape) should be treated as the contract; do not depend on the `lockdown` field from `pi-web-access` as if it were a universal hosted API feature. If cache-only/self-host behavior is needed, make it an explicit adapter option and test it against the deployed server.

A hosted Firecrawl service performs target egress itself. Local validation protects this process and avoids obvious disclosure mistakes, but cannot control the service's DNS, redirects, or internal network. Document that `online_fetch` sends the URL to Firecrawl and make fresh remote fetching an explicit configuration decision (see unresolved decisions).

### OpenAI Codex fallback (search only)

This is the exact flow implemented by `pi-web-access/openai-search.ts` and should be isolated in `codex-search.ts`:

1. Read `web-search.json`; validate `openaiResponsesUrl` as absolute HTTP(S), default `https://api.openai.com/v1/responses`, and validate optional `openaiSearchModel` (`L135-L158`).
2. With a Pi `ExtensionContext`, inspect `ctx.modelRegistry.getAll()`. In provider order `openai-codex`, then `openai`, filter model IDs whose `-` segments contain neither `pro` nor `ultra`, sort numeric-aware descending, prefer an ID containing `terra`, then a bare `gpt-N(.N)?`, then the first candidate (`L13-L33`, `L168-L193`). Call `getApiKeyAndHeaders(preferred)`; a successful key wins and `openaiSearchModel` overrides only the model ID (`L195-L219`). This is how `/login` Codex subscription auth is reused.
3. If Pi auth is unavailable, resolve `openaiApiKey` using the credential-source rules, with `OPENAI_API_KEY` as the environment fallback (`L204-L218`). No key means **ineligible**, not a provider outage.
4. Decode, without verifying, the JWT payload only to detect the `https://api.openai.com/auth` claim and read `chatgpt_account_id` (`L110-L133`). For a Codex provider or Codex JWT, post to `https://chatgpt.com/backend-api/codex/responses`; otherwise post to configured `openaiResponsesUrl` (`L425-L445`). The Codex endpoint is a private/implementation endpoint, not the public documented OpenAI API; isolate it so it can be retired independently.
5. Merge Pi-provided headers excluding nulls, then set `Authorization: Bearer <key>`, `Content-Type: application/json`, and `OpenAI-Beta: responses=experimental`. Codex adds `chatgpt-account-id` when present and `originator: pi` (`L419-L430`). Never log the key or raw headers.
6. Send `{ model, instructions, input: [{ role: "user", content: [{ type: "input_text", text: query }] }], tools: [{ type: "web_search", filters? }], include: ["web_search_call.action.sources"], store: false, stream: true, tool_choice: "required", parallel_tool_calls: true }` (`L432-L442`). Instructions require a concise answer grounded in web results, clickable citations, and encode recency/domain/result-count preferences (`L232-L268`). Domain filters become up to 100 `allowed_domains`/`blocked_domains` values.
7. Parse either JSON or SSE: collect `response.output_item.done` items and a completed response (`L271-L306`), extract message text as the answer and `url_citation`/`web_search_call` sources with de-duplication and capped result count (`L309-L400`). Reject an output with neither answer nor sources.
8. On non-2xx, include only a 300-byte credential-redacted body in the typed error; aborts remain cancellation, not fallback evidence (`L454-L483`). The official public reference for the request shape is [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search); the Codex endpoint/header behavior above is source-derived and must have fixture tests.

## Proposed modules and interfaces

```
extensions/online-web/
  index.ts          # factory; exactly two registerTool calls and lifecycle hooks
  schema.ts         # Type.Object schemas, Static input types, normalization
  config.ts         # path, JSON validation, env/config precedence
  errors.ts         # Data.TaggedError union and classification predicates
  firecrawl.ts      # direct HTTP adapter and response decoders
  codex-search.ts   # Pi auth resolution, request, JSON/SSE parser
  ssrf.ts           # URL/DNS/IP/redirect policy
  output.ts         # bounded formatter and private full-output persistence
  storage.ts        # response IDs, cache/session metadata, branch restore
  prompt.ts         # descriptions, snippets, guidelines
```

Core interfaces should be substitutable in tests:

```ts
interface SearchBackend {
  search(input: SearchRequest, signal: AbortSignal): Effect.Effect<SearchDocument, WebError>;
}
interface FetchBackend {
  fetch(input: FetchRequest, signal: AbortSignal): Effect.Effect<FetchDocument, WebError>;
}
interface CodexBackend {
  search(input: SearchRequest, ctx: ExtensionContext, signal: AbortSignal): Effect.Effect<SearchDocument, WebError>;
}
```

`SearchDocument` and `FetchDocument` should contain typed provider-neutral data, not Pi `AgentToolResult`. Only `index.ts` maps successful values to `{ content: [{type:"text", text}], details }`, runs the Effect, maps interruption to `throw new Error("online_search cancelled")`/`online_fetch cancelled`, and throws all other failures as required by `AGENTS.md`.

## Proposed schemas and behavior

### `online_search`

`Type.Object({ query: Type.String({ minLength: 1, maxLength: 4_000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), source: Type.Optional(StringEnum(["web", "news", "images"])), scrapeResults: Type.Optional(Type.Boolean()), recency: Type.Optional(StringEnum(["day", "week", "month", "year"])), domainFilter: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })) })`.

Defaults: `limit=5`, `source="web"`, `scrapeResults=false`. `recency` and `domainFilter` are translated into Firecrawl's documented request fields where supported; Codex receives the same domain filters and prompt instructions. Return an answer plus numbered, clickable sources. `details` includes `provider`, `query`, `resultCount`, `fallbackUsed`, `truncated`, and optional `fullOutputPath`.

### `online_fetch`

`Type.Object({ url: Type.String({ minLength: 1, maxLength: 8_192 }), onlyMainContent: Type.Optional(Type.Boolean()), waitFor: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })), includeMetadata: Type.Optional(Type.Boolean()) })`.

Exactly one HTTP(S) URL; reject credentials in the URL, non-HTTP schemes, localhost, literal private/reserved IPs, and hostnames resolving to any private/reserved address. Defaults `onlyMainContent=true`, `timeoutMs=60_000`, and metadata omitted from the model text (but available in details). Return markdown plus title/source URL. `details` includes `provider`, `url`, `contentBytes`, `contentLines`, `truncated`, and optional `fullOutputPath`.

## Fallback policy: eligibility is not failure

Resolve **eligibility** before making a provider request:

- Firecrawl search is eligible when its base URL is configured/defaulted and its required credential is available. Firecrawl fetch is eligible under the same condition plus a locally SSRF-valid target.
- Codex search is eligible when Pi model-registry auth resolves, or a valid configured/environment OpenAI key resolves. Merely having an `openaiSearchModel` or an invalid key is not eligibility.
- `online_fetch` has no Codex fallback.

Then classify failures:

| Failure | Firecrawl -> Codex search? | Result |
|---|---:|---|
| Missing credential/base, provider disabled | yes, if Codex eligible | normal fallback; include `fallbackReason: "ineligible"` |
| DNS/network reset, connection failure, timeout, HTTP 408/425/429/5xx | yes, after bounded retry | transient fallback |
| HTTP 400/401/403/404, malformed JSON/envelope, unsupported API version, invalid config | no | throw typed Firecrawl error; do not hide bad setup/auth |
| SSRF/domain-policy rejection, invalid tool input, caller abort | no | throw security/input/cancel error immediately |
| Codex missing auth | n/a | throw an actionable “Codex unavailable” error |
| Codex auth/permission/config/invalid response | n/a | throw; never loop back to Firecrawl |

Use this policy only for automatic (`fallback: auto`, implicit default) search. A future explicit backend selector should be strict; do not silently change a user-requested provider. Preserve both provider diagnostics in the final error only after the policy exhausts eligible candidates.

## Typed Effect 4 error boundary

Define `WebError` as a discriminated `Data.TaggedError` union, for example:

- `InvalidInputError` / `ConfigError` (`field`, `message`)
- `CredentialUnavailableError` (`provider`, `source`) and `CredentialRejectedError`
- `SsrfBlockedError` (`url`, `reason`)
- `HttpError` (`provider`, `status`, `transient`, redacted `body`)
- `NetworkError` (`provider`, `message`, `transient=true`)
- `DecodeError` (`provider`, `message`, `transient=false`)
- `TimeoutError` (`provider`, `timeoutMs`)
- `CancelledError` (`provider`)
- `OutputError` (`operation`, `cause`)

Adapters use `Effect.tryPromise`/`Effect.try` at I/O and parsing boundaries and preserve the typed error. Use `Effect.catchTag`/a small `isFallbackEligible` predicate in the search router, `Effect.timeout` for operation deadlines, and `Effect.runPromiseExit` only in each Pi tool executor. `Cause.hasInterruptsOnly` must map to cancellation; never convert cancellation into a fallback or “no results.” Keep raw causes out of model output and redact credentials in HTTP/provider messages.

## Config and environment precedence

Follow the `pi-web-access` config location (`utils.ts:L5-L12`): `${PI_CODING_AGENT_DIR}/web-search.json`, else `${XDG_CONFIG_HOME}/pi/web-search.json`, else `~/.pi/web-search.json`; this is distinct from Pi's default `PI_CODING_AGENT_DIR=~/.pi/agent` documented in [environment variables](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/environment-variables.md). Parse one JSON object and fail closed on malformed JSON. Do not add Davis's second `.env` parser.

Recommended precedence:

1. Per-call tool fields (query, limit, filters, timeout).
2. Pi model-registry Codex auth (`openai-codex`, then `openai`) for Codex search.
3. Environment variables for literal provider settings: `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL`, `FIRECRAWL_API_VERSION`, `FIRECRAWL_FRESH_SCRAPE`, `OPENAI_API_KEY` (and `OPENAI_RESPONSES_URL`/`OPENAI_SEARCH_MODEL` if supported).
4. JSON config: `firecrawlApiKey`, `firecrawlBaseUrl`, `firecrawlApiVersion`, `firecrawlFreshScrape`, `openaiApiKey`, `openaiResponsesUrl`, `openaiSearchModel`, `ssrf.allowRanges`, `ssrf.trustEnvProxy`, and optional `fetchContent.domainPolicy`.
5. Defaults: Firecrawl hosted v2 base and 5 web results; OpenAI public Responses URL/model selection; SSRF allow list empty and proxy trust false.

For credentials, support `credential-source.ts` semantics: an ordinary literal config key is overridden by its provider environment variable; `$NAME`/`${NAME}` explicitly names an environment value; `!command` is bounded, abortable, and never logged. Validate endpoint URLs (HTTP(S), no embedded credentials), cap domain filters, and clear config caches when tests change config.

## Abort, timeout, retry, and security rules

- Compose the Pi tool `signal` with `AbortSignal.timeout`; pass it through credential resolution, DNS lookup where possible, `fetch`, response-body reads, and SSE parsing. Set Firecrawl search default deadline 35s and fetch 60s (configurable only within schema bounds); Codex 60s.
- Retry at most once for network errors, 408/425/429/5xx, with a small bounded backoff and no retry after abort. Respect a bounded `Retry-After`; do not retry 401/403, 4xx validation, decode, config, or SSRF errors. Fallback occurs only after retry exhaustion.
- Validate the Firecrawl base URL itself before every request. Follow at most five redirects manually, validate every `Location`, and strip `Authorization`, cookies, and API keys on a cross-origin redirect, as `firecrawl.ts:L171-L190` does.
- Validate `online_fetch` targets before sending them to Firecrawl and again for any direct fallback implementation. Resolve all DNS addresses and reject loopback, link-local, private, CGNAT, multicast/reserved IPv4, and loopback/link-local/unique-local/mapped-private IPv6. `ssrf.allowRanges` is an explicit narrow CIDR opt-in only; reject malformed and `/0` ranges. `trustEnvProxy` is opt-in and must not bypass literal IP/localhost/NO_PROXY checks. Domain allow/deny policy is additional restriction, with deny winning.
- Treat result URLs and markdown as untrusted content: do not execute links, inject HTML into TUI, or follow result URLs inside search. Escape/neutralize control characters in display previews.

## Output limits and storage

Pi requires no more than 50 KB or 2,000 lines (`AGENTS.md:L31-L33`; the file-search implementation demonstrates `truncateHead` and details at `index.ts:L235-L244`). Normalize output first, then truncate by both limits without splitting UTF-8 characters. Always append a clear notice containing shown/total bytes and lines.

When truncating, persist the complete normalized output in a private temporary directory (Davis `index.ts:L116-L130`) or, preferably for repeatable session use, `${configDir}/web-search-cache/<responseId>.json` with directory `0700`, file `0600`, atomic temp-write/rename, TTL (one hour), and an allow-listed ID. Append only response ID, provider, URL/title, lengths, timestamp, truncation flag, and path as a custom session entry; never append full page text or secrets. `details.fullOutputPath` is the retrieval mechanism because this scoped feature deliberately does not add `get_search_content`. On shutdown clear in-memory maps and abort in-flight work; restore only validated, unexpired metadata from the current branch, following Pi's session lifecycle and `pi.appendEntry` guidance.

## Tests to implement

Use Bun/node tests in `extensions/test/online-web.test.ts` plus focused modules, with injected clients/fetch/DNS lookup:

1. Schema normalization: empty/oversized query, bounds, defaults, invalid URL/scheme, conflicting fields.
2. Firecrawl search request: exact URL/body/headers, source/limit/scrape options, result mapping and de-duplication; malformed JSON/envelope and empty markdown.
3. Firecrawl fetch: title precedence, metadata option, timeout, HTTP errors, base URL validation, API version, credential redaction.
4. Codex auth: Pi registry preferred over API key; provider/model preference; `openaiSearchModel`; Codex JWT detection/account header/originator; public API-key endpoint; `$ENV`/`!command` resolution and abort. Assert keys never occur in errors.
5. Codex transport/parser: exact request body, JSON and SSE fixtures, citations from both annotations and `web_search_call`, no-answer/no-source rejection, 401/429/5xx classification, URL cleanup.
6. Routing: Firecrawl ineligible -> Codex; Firecrawl timeout/network/429/5xx after one retry -> Codex; Firecrawl 401/400/decode/SSRF -> no fallback; no eligible backend -> combined actionable error; Codex failure never loops.
7. SSRF: localhost, alternate IPv4, private/metadata, IPv6, DNS rebinding/all-address results, domain allow/deny, redirects to private hosts, cross-origin header stripping, narrow allowed CIDR and rejected `/0`.
8. Cancellation/deadlines: abort before request, during response body/SSE, during retry/backoff, and timeout; assert no fallback and no false success.
9. Output/storage: 2,001 lines and >50 KB persist full output, notices report exact totals, cache/session entry remains bounded, file permissions/TTL/path traversal, restore and missing/expired cache behavior.
10. Tool contract: factory registers only `online_search` and `online_fetch`; execute throws on typed failures and returns `AgentToolResult` details on success. Add a Pi smoke test with a minimal `ExtensionAPI` mock, matching current `extensions/test` style.

## Phased implementation

1. **Contract/config phase:** settle schemas, config path/precedence, error tags/classifier, limits, and SSRF policy; add pure tests and prompt descriptions.
2. **Firecrawl phase:** implement validated HTTP adapter, search/fetch decoders, timeout/retry, output persistence, and Firecrawl-only tests.
3. **Codex phase:** port the exact auth/request/parser flow behind an injected adapter; add JSON/SSE/auth fixture tests. Confirm current Pi model-registry types against the installed peer version.
4. **Router/tool phase:** implement eligibility-vs-transient fallback for search, strict fetch behavior, one Effect boundary per tool, `onUpdate` status, details, and rendering. Add registration/routing/cancellation tests.
5. **Session/security phase:** add cache/session metadata, lifecycle abort/restore, SSRF redirect tests, redaction review, and `bun install && bun run check`; manually smoke-test with `pi -e .` and both tools.
6. **Operational phase:** document required keys and the private Codex endpoint caveat in the extension README, then review the final diff to ensure only the new extension, its tests, dependency changes (if any), and this plan are included. This report itself requests no implementation.

## Unresolved decisions

- **Firecrawl hosted default and egress:** Should default `online_fetch` use hosted Firecrawl fresh scraping (convenient but URL disclosure/server-side SSRF risk), require `firecrawlFreshScrape=true`, or default to a self-hosted/cache-only deployment? Decide before coding and test the selected contract; do not assume `lockdown` is portable.
- **Firecrawl dependency:** Direct HTTP gives precise SSRF/redirect/error control; the Davis `firecrawl` SDK gives typed endpoint ergonomics. Prefer direct HTTP unless the selected SDK version demonstrably supports base URLs, abort signals, and the required response shapes.
- **Codex private endpoint policy:** Is reusing `chatgpt.com/backend-api/codex/responses` acceptable for this package, or should Codex fallback be API-key/public-endpoint only until Pi exposes a stable Codex transport? This affects supportability and must be an explicit feature flag if retained.
- **Search result shape:** Whether `online_search` returns Firecrawl's raw result objects, normalized sources plus answer, or only normalized sources. Recommendation: normalized answer/sources with raw provider details excluded from model context.
- **Persistence UX:** With only two tools, is a filesystem path sufficient for retrieving truncated content, or should `online_fetch` support an `offset`/`limit` continuation in a later version? Do not add a third retrieval tool under this scope.

## Stable references

- Firecrawl [Search API](https://docs.firecrawl.dev/api-reference/endpoint/search) and [Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape).
- OpenAI [Responses API web search](https://developers.openai.com/api/docs/guides/tools-web-search).
- Pi [Extensions](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md), [Packages](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md), and [environment variables](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/environment-variables.md).

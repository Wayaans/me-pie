# Installed Pi default compaction

This report describes the installed package at:

`/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent`

Citations below are to that local installation (not to upstream). The implementation source maps embedded in `dist/**/*.js.map` identify the corresponding TypeScript sources, but the cited generated JavaScript/declarations are the executable/public artifacts.

## Triggers and settings

Pi has manual and automatic compaction; `/compact [instructions]` is manual. Automatic compaction is enabled by default and is checked after an agent run and before submitting a new prompt. The README describes the proactive and overflow-recovery paths ([`README.md:272-280`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md#L272-L280)); `_checkCompaction()` is called from the post-run path ([`dist/core/agent-session.js:776-783`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L776-L783)) and before a new prompt ([`dist/core/agent-session.js:861-865`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L861-L865)).

The settings are:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`enabled` defaults to `true`; `reserveTokens` and `keepRecentTokens` default to `16384` and `20000` ([`dist/core/settings-manager.js:506-528`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js#L506-L528), [`dist/core/compaction/compaction.js:74-78`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L74-L78)). Global settings are `~/.pi/agent/settings.json`; project settings are `<project-dir>/.pi/settings.json` ([`docs/compaction.md:381-401`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md#L381-L401)). Disabling `enabled` disables *all automatic checks, including overflow recovery* (`_checkCompaction()` returns immediately), but does not prevent manual `/compact` ([`dist/core/agent-session.js:1510-1515`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1510-L1515), [`docs/compaction.md:395-401`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md#L395-L401)).

The proactive threshold is strict:

```text
contextTokens > contextWindow - reserveTokens
```

([`dist/core/compaction/compaction.js:158-164`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L158-L164)). `contextTokens` uses the most recent valid assistant usage (`totalTokens`, or the component sum if `totalTokens` is falsy), plus estimated tokens for messages after that assistant. If there is no valid usage, it estimates every message ([`dist/core/compaction/compaction.js:86-88`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L86-L88), [`dist/core/compaction/compaction.js:90-103`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L90-L103), [`dist/core/compaction/compaction.js:127-155`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L127-L155)). Aborted, error, and zero-token assistant messages are not valid usage sources.

## Cut-point algorithm

`prepareCompaction()` refuses to prepare when the branch is empty or its last entry is already a compaction; it returns no work if neither complete history nor a split-turn prefix exists. It computes `tokensBefore` from the rebuilt active session context, then finds the cut point using `keepRecentTokens` ([`dist/core/compaction/compaction.js:492-557`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L492-L557)).

`findCutPoint()` walks backward from the newest entry, adding estimated message tokens until the total is **at least** `keepRecentTokens`, then chooses the nearest valid cut point at or after that scan position ([`dist/core/compaction/compaction.js:308-333`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L308-L333)). Estimates use a conservative chars/4 heuristic: images count as 4,800 characters; assistant thinking/text/tool-call arguments, user/custom/tool-result content, bash command/output, and summary text have role-specific accounting ([`dist/core/compaction/compaction.js:168-216`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L168-L216)).

Valid cut entries are user, assistant, bash-execution, custom, branch-summary, and compaction-summary messages; tool results are never cut. Adjacent non-context metadata immediately before the selected entry is included, but scanning stops at a compaction or context-visible entry ([`dist/core/compaction/compaction.js:227-282`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L227-L282), [`dist/core/compaction/compaction.js:334-342`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L334-L342)). If the cut is not a turn-start entry, Pi searches backward for the turn start (user, bash, custom, branch-summary, or compaction-summary) and marks a split turn ([`dist/core/compaction/compaction.js:241-265`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L241-L265), [`dist/core/compaction/compaction.js:343-351`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L343-L351)). Thus a huge turn can be cut at an assistant message while its following tool results remain kept.

For a normal cut, `messagesToSummarize` spans from the previous compaction boundary (or session start) to the first kept entry. For a split turn, complete earlier turns go in `messagesToSummarize`, while the prefix of the split turn goes in `turnPrefixMessages`; the suffix beginning at `firstKeptEntryId` is retained ([`dist/core/compaction/compaction.js:520-539`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L520-L539)). The default split-turn result is two summaries joined as:

```text
<history summary>

---

**Turn Context (split turn):**

<turn-prefix summary>
```

The exact split-turn prefix prompt is:

```text
This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the kept recent work]

Be concise. Focus on what's needed to understand the kept suffix.
```

It has a half-reserve output budget ([`dist/core/compaction/compaction.js:562-575`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L562-L575), [`dist/core/compaction/compaction.js:588-599`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L588-L599), [`dist/core/compaction/compaction.js:624-642`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L624-L642)).

## Exact default summarization request

The default system prompt is exactly:

```text
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

([`dist/core/compaction/utils.js:136-141`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js#L136-L141)).

For a non-repeated compaction, the user request is exactly this template, with `${conversationText}` substituted and the final prompt appended:

```text
<conversation>
${conversationText}
</conversation>

The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

The exact initial template is [`dist/core/compaction/compaction.js:356-387`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L356-L387); request assembly is [`dist/core/compaction/compaction.js:467-485`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L467-L485).

When a previous compaction exists, the default user request instead uses this exact update prompt:

```text
<conversation>
${conversationText}
</conversation>

<previous-summary>
${previousSummary}
</previous-summary>

The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

The update template is [`dist/core/compaction/compaction.js:388-425`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L388-L425). `/compact` instructions are appended literally as `\n\nAdditional focus: ${customInstructions}` ([`dist/core/compaction/compaction.js:461-476`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L461-L476)). The summarization user message has role `user`, one text content block, and `timestamp: Date.now()` ([`dist/core/compaction/compaction.js:477-483`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L477-L483)).

## Exact message serialization

Pi first calls `convertToLlm()`. Bash execution becomes a user text message (unless `excludeFromContext`, as used by `!!`); custom messages become user messages; branch and compaction summaries become user messages wrapped in their respective summary tags. Ordinary user, assistant, and tool-result messages pass through ([`dist/core/messages.js:75-115`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js#L75-L115)).

`serializeConversation()` emits only nonempty content, joining records with two newlines:

- User: `[User]: ${contentText(content, "")}`
- Assistant thinking blocks: `[Assistant thinking]: ${thinkingBlocks.join("\n")}`
- Assistant text blocks: `[Assistant]: ${contentText(content)}`
- Assistant tool calls: `[Assistant tool calls]: ${name(k=${JSON.stringify(v)}, ...)}`; calls are joined with `; ` and object-entry order is retained
- Tool results: `[Tool result]: ${contentText(content, "")}`

Tool results are limited to the first 2,000 characters; if truncated the exact suffix is `\n\n[... ${truncatedChars} more characters truncated]`. Records are joined with `\n\n` ([`dist/core/compaction/utils.js:74-135`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js#L74-L135)). This serialized text is intentionally not presented as a normal dialogue to continue.

## Model, options, retries, and file tracking

Default compaction uses the active model and its resolved summarization auth (`_getSummarizationRequestAuth(this.model)`), including provider-specific API key, headers, base URL, and environment where available ([`dist/core/agent-session.js:195-217`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L195-L217), [`dist/core/agent-session.js:1372-1378`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1372-L1378)). A custom `agent.streamFunction` is used when present; otherwise `completeSimple()` is used. The default output limit is `min(floor(0.8 * reserveTokens), model.maxTokens)` (unbounded by `model.maxTokens` if that value is nonpositive), and split-prefix summarization uses `min(floor(0.5 * reserveTokens), model.maxTokens)` ([`dist/core/compaction/compaction.js:426-450`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L426-L450), [`dist/core/compaction/compaction.js:461-485`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L461-L485), [`dist/core/compaction/compaction.js:624-636`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L624-L636)). If the model supports reasoning, the current thinking level is passed unless it is `off` ([`dist/core/compaction/compaction.js:426-431`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L426-L431)). No temperature is set.

Every summarization call overrides options with `cacheRetention: "none"` and a fresh `uuidv7()` `sessionId`, then uses `retryAssistantCall`. The regular retry settings default to enabled, 3 retries, and a 2,000 ms base delay ([`dist/core/compaction/compaction.js:434-450`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L434-L450), [`dist/core/settings-manager.js:539-555`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js#L539-L555)). Retry is for transient summarization stream failures; a response with `stopReason: "error"` becomes `Summarization failed: ...` ([`dist/core/compaction/compaction.js:486-490`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L486-L490)).

Default file tracking extracts `read`, `write`, and `edit` tool calls. It carries forward `details.readFiles`/`modifiedFiles` only from the prior Pi-generated compaction (`!fromHook`), excludes modified files from the read-only list, sorts both lists, and appends `<read-files>` / `<modified-files>` XML blocks to the summary ([`dist/core/compaction/compaction.js:15-44`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L15-L44), [`dist/core/compaction/utils.js:30-69`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js#L30-L69), [`dist/core/compaction/compaction.js:607-619`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L607-L619)).

## Session JSONL and context reconstruction

Compaction does not delete old history. It appends a top-level JSONL entry as the current leaf's child:

```typescript
{
  type: "compaction",
  id,
  parentId,
  timestamp,
  summary,
  firstKeptEntryId,
  tokensBefore,
  details,
  usage,
  fromHook: fromExtension
}
```

(`undefined` properties disappear when JSON-stringified.) The append and JSONL persistence paths are [`dist/core/session-manager.js:754-815`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L754-L815) and [`dist/core/session-manager.js:724-752`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L724-L752); the public shape is [`dist/core/session-manager.d.ts:36-46`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts#L36-L46). The active branch is then rebuilt into `agent.state.messages` ([`dist/core/agent-session.js:1432-1435`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1432-L1435)).

For context, the latest compaction is converted to an agent message with:

```text
The conversation history before this point was compacted into the following summary:

<summary>
${summary}
</summary>
```

([`dist/core/messages.js:7-12`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js#L7-L12), [`dist/core/messages.js:48-54`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js#L48-L54)). `buildContextEntries()` emits that summary first, then entries from the old path starting at `firstKeptEntryId`, then entries after the compaction entry; older summarized entries are omitted ([`dist/core/session-manager.js:190-225`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js#L190-L225)). If the kept ID is absent from the path, no old pre-compaction entries are added. The complete JSONL remains available for `/tree` ([`README.md:278-280`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md#L278-L280)).

On repeated compaction, preparation uses the latest compaction summary as `previousSummary` and starts the next summarized span at that compaction's `firstKeptEntryId`; if that ID is absent, it starts after the compaction entry ([`dist/core/compaction/compaction.js:496-510`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L496-L510)). This deliberately summarizes surviving kept messages again while iteratively updating the prior summary. `tokensBefore` is recalculated from the rebuilt context before the new entry is written ([`dist/core/compaction/compaction.js:511-513`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L511-L513)). A branch ending in a compaction cannot be compacted again until new entries exist ([`dist/core/compaction/compaction.js:492-495`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js#L492-L495)).

## Overflow recovery and edge cases

`isContextOverflow()` recognizes provider error-message patterns, silent overflow when `stopReason === "stop"` and `usage.input + usage.cacheRead > contextWindow`, and a length-stop with zero output filling at least 99% of the context window. `isRecoverableLength()` also treats `stopReason === "length"` with output below the original desired max output as recoverable ([nested installed dependency `node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-165`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js#L130-L165)). The assistant must be from the currently selected provider/model; stale messages from a different model and messages at or before the latest compaction boundary are ignored ([`dist/core/agent-session.js:1517-1529`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1517-L1529)).

- A recoverable overflow/error or recoverable length stop triggers `reason: "overflow"`. If the assistant stop reason is not `"stop"`, Pi removes the final assistant message from in-memory state, compacts, and retries the interrupted turn once ([`dist/core/agent-session.js:1531-1560`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1531-L1560)). The failed response remains in session JSONL; after rebuilding, Pi removes a final `error`/`length` assistant again so `agent.continue()` can proceed ([`dist/core/agent-session.js:1694-1705`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1694-L1705)).
- A successful `stop` response that merely exceeds the configured context window compacts but is not retried, because the answer already completed ([`dist/core/agent-session.js:1537-1541`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1537-L1541)).
- A second recovery attempt is not made. Pi emits `Context overflow recovery failed after one compact-and-retry attempt...` and settles ([`dist/core/agent-session.js:1542-1551`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1542-L1551)).
- Proactive threshold compaction has `willRetry: false`; it compacts and does not automatically continue the just-finished turn. Queued messages may cause one continuation after successful auto-compaction ([`dist/core/agent-session.js:1562-1590`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1562-L1590), [`dist/core/agent-session.js:1707-1709`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1707-L1709)).
- Auto-compaction failures are caught, emit a failure event, and return `false`; there is no second default attempt after a custom handler/model failure ([`dist/core/agent-session.js:1711-1729`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1711-L1729)).

## Extension interception contract

Register `pi.on("session_before_compact", handler)`. It fires for manual, threshold, and overflow compaction and receives:

```typescript
interface SessionBeforeCompactEvent {
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  signal: AbortSignal;
}
```

The exact public declarations are [`dist/core/extensions/types.d.ts:440-461`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L440-L461), and the preparation fields are [`dist/core/compaction/compaction.d.ts:96-126`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts#L96-L126). The handler may return:

```typescript
{ cancel: true }
```

to cancel, or:

```typescript
{
  compaction: {
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    usage?: Usage,
    details?: unknown
  }
}
```

(`SessionBeforeCompactResult` is [`dist/core/extensions/types.d.ts:817-820`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L817-L820); `CompactionResult` is [`dist/core/compaction/compaction.d.ts:15-28`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts#L15-L28)). Pi supplies IDs/parent linkage when saving; the extension must supply a valid kept-entry ID and its own token count/summary. `details` is persisted but not sent as context.

Returning `undefined` (including an extension that deliberately cannot handle the selected model) falls through to the default compaction. The installed example demonstrates this fallback for missing Gemini, empty output, and caught model errors, while returning a custom result on success ([`examples/extensions/custom-compaction.ts:27-32`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts#L27-L32), [`examples/extensions/custom-compaction.ts:77-115`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts#L77-L115)). Extension handler exceptions are logged/swallowed by the extension runner, so the core then uses default compaction; handlers are run in extension order and a non-cancel result is retained until a later nonempty result replaces it ([`dist/core/extensions/runner.js:570-603`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js#L570-L603)).

Cancellation is not fallback: manual cancellation throws `Compaction cancelled` and emits `compaction_end` with `aborted: true`; auto cancellation emits an aborted `compaction_end` and returns `false`, without appending a summary or retrying ([`dist/core/agent-session.js:1399-1405`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1399-L1405), [`dist/core/agent-session.js:1466-1482`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1466-L1482), [`dist/core/agent-session.js:1623-1632`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1623-L1632)). The extension should pass `event.signal` to its model/fetch work; an abort after generation but before append is checked and prevents persistence ([`dist/core/agent-session.js:1429-1432`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L1429-L1432), [`examples/extensions/custom-compaction.ts:77-88`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts#L77-L88)). On custom success, `session_compact` reports `fromExtension: true`, the saved entry, `reason`, and `willRetry` ([`dist/core/extensions/types.d.ts:452-460`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L452-L460)).

For an extension replacing default behavior, the smallest safe pattern is therefore: consume `preparation.messagesToSummarize` and (if desired) `turnPrefixMessages`, use `convertToLlm()` plus `serializeConversation()`, honor `signal`, return `firstKeptEntryId` and `tokensBefore` from `preparation`, and return `undefined` on unsupported/empty/failure so the normal default remains available. The installed complete example instead intentionally summarizes all supplied messages and uses Gemini Flash with `maxTokens: 8192`, `cacheRetention: "none"`, and a fresh session ID ([`examples/extensions/custom-compaction.ts:24-46`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts#L24-L46), [`examples/extensions/custom-compaction.ts:79-108`](/Users/wayanary/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts#L79-L108)).

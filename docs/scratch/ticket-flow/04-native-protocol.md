# Stage 4: Native protocol

**Status: Complete**

## Objective

Connect the orchestrator and worker extensions through an authenticated local Unix socket, verify worker identity and launch profile, and deliver prompts and feedback through Pi APIs rather than tmux input.

## Deliverables

Add:

```text
protocol/messages.ts
protocol/framing.ts
protocol/server.ts
protocol/client.ts
protocol/runtime.ts
```

Integrate the protocol with orchestrator and worker `session_start`/`session_shutdown` handlers.

## Socket location and permissions

Use a short runtime path:

```text
${TMPDIR}/mepie-ticket-flow/<short-run-id>.sock
```

Do not create sockets in the project. Create the parent directory with mode `0700`, remove a stale socket only after validating run ownership, and clean it idempotently on shutdown.

Persist the intended socket path in global run state. Persist a random connection token in an owner-only file or state field; never log or render it.

## Framing and bounds

Use strict UTF-8 JSONL framing over `node:net`. Split only on LF, tolerate a preceding CR, and bound both line size and buffered bytes. Close peers that send malformed, oversized, or unsupported messages.

Every message envelope contains:

```ts
{
  version: 1;
  messageId: string;
  runId: string;
  workItemId: string;
  type: string;
  payload: unknown;
}
```

Decode every payload with a schema. Add an acknowledgement or request ID where commands need confirmation.

## Handshake

The worker connects and sends:

- Protocol version
- Run ID
- Work-item ID
- Connection token
- Pi session ID/file when available
- Actual provider/model
- Actual thinking level

The server verifies all identity fields against persisted state. Reject unknown, stale, duplicate, or mismatched workers.

A thinking level clamped by Pi is a mismatch. Do not delegate on mismatch.

On success, persist requested and actual launch profiles and emit `worker-profile-verified`.

## Message types

Support:

Worker to orchestrator:

- `worker-connected`
- `worker-ready`
- `worker-progress`
- `worker-report`
- `worker-blocked`
- `worker-failed`
- `worker-shutdown`

Orchestrator to worker:

- `delegate`
- `feedback`
- `accepted`
- `shutdown`
- `ping`

Keep transport messages separate from domain events. Translate validated messages into Stage 1 events through one adapter.

## Pi integration

After successful verification, `workflow_worker` delegation sends a native `delegate` message. The worker receives it and calls `pi.sendUserMessage(prompt)` while idle. If Pi is streaming, queue feedback with the correct follow-up behavior.

Never send the ticket prompt through `tmux send-keys`.

The worker must accept only one delegation for its bound work-item ID. Duplicate delivery with the same message ID is idempotent; conflicting second prompts fail.

## Lifecycle and cancellation

Start the server and client during `session_start`, not in the extension factory. Wrap server, sockets, listeners, timers, and retry fibers in scoped resources. Close them idempotently during `session_shutdown`.

The worker client retries transient connection failures with bounded backoff so it can survive orchestrator reloads. It must stop retrying after explicit shutdown or identity rejection.

Expose a wait primitive backed by a queue/deferred abstraction. Cancelling `workflow_worker(action: "wait")` cancels only that wait, not the worker.

## Tests

Cover:

- JSONL fragmentation and multiple frames per chunk
- CRLF tolerance
- Invalid JSON and oversized frames
- Protocol-version mismatch
- Token, run, item, model, and thinking mismatch
- Successful handshake
- Duplicate connection handling
- Idempotent message delivery
- Delegation before verification rejection
- Worker reconnect after server restart
- Cancellation and resource cleanup
- Socket path outside the project

Use temporary Unix sockets in tests and skip only on platforms that genuinely lack support.

## Acceptance criteria

- A worker connects and is authenticated without terminal scraping.
- The controller verifies exact provider/model and thinking before delegation.
- Delegation reaches normal Pi through `pi.sendUserMessage()`.
- Feedback can reach the same Pi session.
- Reloading the orchestrator permits bounded worker reconnection.
- `bun run check` passes.

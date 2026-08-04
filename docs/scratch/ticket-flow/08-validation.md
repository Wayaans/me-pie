# Stage 8: Validation and release readiness

**Status: Complete**

## Objective

Close integration gaps, harden failure behavior, document operation, and prove the complete AFK workflow from free-form planning through sequential completion and recovery.

## Deliverables

- Complete unit and integration coverage under `extensions/test/`.
- Add `extensions/ticket-flow/README.md` with user-facing usage and recovery instructions.
- Update the repository `README.md` included-extension list.
- Add a manual tmux smoke-test checklist.
- Review all output truncation, permissions, cancellation, and cleanup paths.

## Test architecture

Keep core logic behind injectable interfaces:

- Clock and ID generation
- Global filesystem/state store
- tmux command runner
- Protocol transport
- Pi message sender/shutdown adapter

Normal `bun test` must not require a live tmux server or model credentials. Use deterministic fakes for state-machine and controller integration tests.

## Unit coverage

Ensure focused tests cover:

- Domain schemas and migrations
- Plan validation and arbitrary source paths
- Dependency sorting and cycles
- State transitions and idempotency
- Global path hashing
- Secure permissions
- Atomic writes and event replay
- Lock acquisition and takeover rules
- tmux command parsing and ownership checks
- Protocol framing, authentication, and bounds
- Report validation
- Completion strategies
- Recovery reconciliation

## Integration scenarios

Build controller-level tests for:

1. A three-item sequential run.
2. Content-derived order differing from filename order.
3. Default launch profile with one per-item override.
4. Missing model/thinking preventing finalization.
5. Worker model mismatch preventing delegation.
6. Worker thinking-level clamping preventing delegation.
7. Progress followed by a valid report.
8. Invalid report followed by revision and acceptance.
9. Runtime blocker, user resolution, and same-worker resume.
10. Worker crash before report.
11. Orchestrator restart while worker runs.
12. Report persisted before orchestrator acceptance.
13. Stop during active implementation.
14. Attempted foreign tmux-window closure.
15. Final tool-set restoration.

Assert that no workflow metadata is created under the project in every scenario.

## Live tmux smoke test

Document an opt-in manual test using a disposable repository and inexpensive model. It should verify:

- `/ticket-flow tmux <prompt>` creates one worker window.
- The worker displays normal interactive Pi.
- The requested model and thinking appear in worker state.
- A `/implement ...` delegation expands normally.
- The worker retains normal tools.
- Native progress/report events reach the orchestrator.
- Report revision reaches the same worker session.
- Acceptance closes the correct window and starts the next.
- Detaching and reattaching tmux does not interrupt the run.
- Reloading the orchestrator reconnects without duplicate workers.
- Generated metadata appears only under the global Pi agent state directory.

Do not automate paid model calls in the default test suite.

## Security and reliability review

Verify:

- No ticket or prompt text is interpolated into shell commands.
- Connection tokens never appear in logs, tool output, or process arguments.
- State and reports use owner-only permissions.
- Socket messages and tool output have byte and line limits.
- Only workflow-owned tmux IDs can be closed.
- Worker tools cannot submit reports for another run/item.
- Orchestrator tools cannot be called from worker role.
- Worker implementation tools remain unrestricted.
- Cancellation releases waits and listeners without killing workers unexpectedly.
- Session shutdown is idempotent.

## Documentation

Document:

- Requirements: Pi, tmux, Bun for development
- Command syntax and free-form examples
- Model/thinking requirements
- Delegation templates and `/implement`
- Global state location and why it is not committed
- Tool roles
- Pause, resume, stop, and recover
- Ledger-only versus project-mutating completion
- Troubleshooting profile mismatch, stale lock, and missing window
- How to inspect or delete completed global runs safely

## Final gates

Run:

```bash
bun install
bun run check
```

Then run the manual package smoke test:

```bash
pi -e .
```

Invoke `/ticket-flow tmux ...` only in a disposable tmux project for final verification.

## Acceptance criteria

- All unit and integration tests pass without tmux or credentials.
- The documented live smoke workflow succeeds.
- Recovery succeeds without duplicate workers.
- Exact model/thinking enforcement is demonstrated.
- No workflow-generated metadata enters Git status.
- User and extension documentation match implemented behavior.
- `bun run check` passes.

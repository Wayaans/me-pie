# Ticket Flow implementation plan

This directory breaks Ticket Flow into eight implementation stages. Ticket Flow coordinates a Pi orchestrator and one normal interactive Pi worker at a time in tmux.

## Fixed product decisions

- Start the workflow with `/ticket-flow tmux <free-form prompt>`.
- Accept arbitrary ticket formats; the orchestrator decides work-item boundaries and order.
- Support Pi workers only.
- Support tmux only.
- Run workers as normal interactive Pi sessions with unrestricted tools.
- Require an exact model and thinking level for every work item; never fall back silently.
- Keep the orchestrator out of implementation and code auditing.
- Communicate with workers through a native local socket, not terminal scraping.
- Persist workflow metadata under `getAgentDir()/state/ticket-flow`, never in the project.
- Run one work item at a time.

## Stages

1. [Domain and persistence](./01-domain-and-persistence.md)
2. [Command and orchestrator mode](./02-command-and-orchestrator.md)
3. [tmux and worker startup](./03-tmux-and-worker-startup.md)
4. [Native protocol](./04-native-protocol.md)
5. [Worker and report tools](./05-worker-and-report-tools.md)
6. [Review and automatic progression](./06-review-and-progression.md)
7. [Recovery and lifecycle control](./07-recovery-and-lifecycle.md)
8. [Validation and release readiness](./08-validation.md)

User operation and recovery are documented in [`extensions/ticket-flow/README.md`](../../../extensions/ticket-flow/README.md). The opt-in release checklist is [`tmux-smoke.md`](./tmux-smoke.md).

## Dependency order

Implement the stages in order. Each stage may add tests for its own behavior, while Stage 8 closes integration gaps and adds end-to-end coverage. Do not defer all testing to Stage 8.

## Proposed extension tools

Orchestrator role:

- `workflow_plan`
- `workflow_worker`
- `workflow_review_report`
- `workflow_control`

Worker role:

- `workflow_context`
- `workflow_submit_report`

## Completion gate

Every stage must pass:

```bash
bun run check
```

The implementation must not create or require a project-local `.mepie` directory.

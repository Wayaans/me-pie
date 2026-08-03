# Stage 2: Command and orchestrator mode

## Objective

Add `/ticket-flow tmux <free-form prompt>`, establish orchestrator role behavior, register the four orchestrator tools, and support planning through finalization without spawning a worker yet.

## Deliverables

Add:

```text
index.ts
role.ts
command.ts
controller.ts
orchestrator/system-prompt.ts
orchestrator/tools.ts
```

Extend Stage 1 schemas for tool inputs and persisted planning details.

## Role detection

Determine the role once when the extension loads:

- `MEPIE_WORKFLOW_ROLE=worker` selects worker role.
- Any other value selects orchestrator role.

Do not register `/ticket-flow` or orchestrator tools in worker role. Reject nested workflow startup from a worker.

## Command parsing

Register `/ticket-flow` and require this shape:

```text
/ticket-flow tmux <free-form prompt>
```

Parsing rules:

- The first token must be exactly `tmux`.
- Preserve the remaining prompt text exactly apart from outer whitespace.
- Reject an empty prompt.
- Return a clear error for unsupported backends.
- Require TUI mode and an active tmux environment.

The command creates a run, stores the original prompt, acquires the project lock, and sends an internal user message that starts orchestrator analysis. It must not perform long-lived work in the extension factory.

## Orchestrator instructions

Inject workflow-specific instructions only while an active run exists. The instructions must state that the orchestrator:

- Interprets arbitrary ticket formats.
- Reads all relevant ticket and specification material.
- Decides work-item boundaries, requirements, dependencies, and order.
- Resolves all known user questions before finalization.
- Never implements, edits source code, runs implementation checks, or audits code.
- Requires explicit model and thinking values.
- Uses only workflow tools to control workers.

Preserve the user’s original system prompt and append the workflow contract through `before_agent_start`.

## Tool registration

Register skeletons with strict TypeBox schemas and unique names:

### `workflow_plan`

Actions: `save`, `update`, `finalize`.

- `save` validates and persists the complete normalized plan.
- `update` applies typed plan changes and logs them.
- `finalize` verifies all plan invariants and changes the run to `ready`.
- In this stage, `finalize` reports that worker execution is pending Stage 3.

### `workflow_worker`

Register the schema for `delegate`, `wait`, `read`, `send`, and `close`, but return a typed “not available before worker runtime” failure in this stage.

### `workflow_review_report`

Register `inspect`, `accept`, `revise`, and `block`; reject use before a report exists.

### `workflow_control`

Implement `status`, `pause`, and `stop` for planning-only runs. Reserve `resume` and `recover` for Stage 7 with explicit errors.

Throw from tool execution for failures. Keep tool output bounded and persist branch-relevant workflow state in tool-result details as well as the global store.

## Tool restriction

When a run starts, save the orchestrator’s previous active-tool list. Keep read-only discovery tools, `ask_me`, and the four workflow tools active. Remove implementation mutation tools from the orchestrator.

Restore the previous active-tool list when the run stops or completes. Persist enough information to recover conservatively after reload, but do not overwrite changes made by unrelated extensions without checking the current set.

## Planning UX

Use footer status such as:

```text
ticket-flow · analyzing
ticket-flow · awaiting user
ticket-flow · ready · 8 items
```

Guard UI calls with `ctx.hasUI` or TUI mode as appropriate.

## Tests

Cover:

- Command parsing and prompt preservation
- Rejection outside tmux or TUI mode
- Unsupported backend errors
- Worker-role command exclusion
- Run creation and lock acquisition
- System-prompt injection only during an active run
- Tool schemas and legal action dispatch
- Finalization failures for missing model/thinking, cycles, and unresolved questions
- Active-tool restriction and restoration
- Status output truncation

## Acceptance criteria

- One command creates a persisted planning run.
- The orchestrator can save, update, and finalize an arbitrary work-item plan.
- Missing launch configuration cannot silently default.
- The orchestrator cannot access normal mutation tools during a workflow.
- No worker or tmux window is created yet.
- `bun run check` passes.

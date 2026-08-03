# Ticket Flow — complete proposed solution

## 1. Goal

Ticket Flow automates a sequence of implementation tickets using:

```text
Pi orchestrator → tmux window → normal interactive Pi worker
```

The orchestrator:

- Finds and analyzes tickets
- Determines the correct order
- Resolves known user intervention before execution
- Delegates one ticket at a time
- Waits for structured reports
- Reviews reports against ticket requirements
- Records comments and completion
- Closes the worker
- Continues until all tickets are complete

The orchestrator never:

- Implements tickets
- Fixes code
- Runs implementation checks
- Audits the worker’s code

The first version supports only:

- Pi as orchestrator
- Pi as worker
- tmux as terminal manager

---

## 2. User command

The complete workflow starts with one command:

```text
/ticket-flow tmux <free-form prompt>
```

Example:

```text
/ticket-flow tmux Tickets are in @docs/tickets and the specifications
are in @docs/specs. Use openai/gpt-5.6-sol with high thinking.

Determine the correct implementation order. Delegate each ticket using:
/implement this ticket {ticket} using the specifications at {specs}
```

Another example:

```text
/ticket-flow tmux Implement the tickets in @planning/auth.

The filenames suggest an order, but inspect their contents and determine
the actual dependencies.

Use openai/gpt-5.6-terra with medium thinking for database work and
openai/gpt-5.6-sol with high thinking for everything else.
```

The prompt may describe:

- Ticket directories
- Individual ticket files
- Specification files
- Supporting documents
- Default model and thinking level
- Per-ticket model overrides
- Delegation prompt templates
- Pi skills or prompt commands
- Completion behavior
- Additional project constraints

There is no separate prepare or run command.

---

## 3. Ticket format

Ticket Flow imposes no ticket schema.

Tickets do not need:

- Numbered filenames
- Markdown
- YAML frontmatter
- Explicit status fields
- Dependency metadata
- A specific directory layout

The orchestrator analyzes the referenced material and decides:

- What constitutes a ticket
- Whether one file contains multiple work items
- Whether several files form one work item
- Which specifications apply
- What each ticket requires
- Which tickets depend on others
- The correct execution order

Names such as:

```text
01 - database.md
02 - repository.md
03 - api.md
```

are useful evidence, but they do not force the order. Content and dependencies take precedence.

---

## 4. Architecture

```text
Parent Pi session
│
├── Ticket Flow extension: orchestrator role
│   ├── /ticket-flow command
│   ├── Orchestrator workflow tools
│   ├── Workflow state machine
│   ├── Persistent global state
│   ├── Native socket server
│   └── tmux controller
│
├── tmux window: tf-01-database
│   └── Normal interactive Pi
│       └── Ticket Flow extension: worker role
│           ├── workflow_context
│           ├── workflow_submit_report
│           └── Native socket client
│
└── Global Ticket Flow state
```

The same extension runs in two roles.

### Orchestrator role

Used when Pi starts normally.

Registers:

```text
workflow_plan
workflow_worker
workflow_review_report
workflow_control
```

### Worker role

Activated by:

```text
MEPIE_WORKFLOW_ROLE=worker
```

Registers:

```text
workflow_context
workflow_submit_report
```

Worker Pi does not receive the orchestrator tools.

---

## 5. End-to-end lifecycle

### Step 1: initialize

When the user invokes `/ticket-flow`:

1. Validate that `tmux` was selected.
2. Verify that the current process runs inside tmux.
3. Preserve the free-form prompt unchanged.
4. Create a globally persisted workflow run.
5. Acquire a project workflow lock.
6. Put the parent Pi into orchestrator mode.
7. Trigger the planning turn.

If another workflow already controls the same project, ask whether to recover it or stop.

### Step 2: analyze

The orchestrator:

1. Interprets the free-form prompt.
2. Finds the referenced ticket and specification material.
3. Reads all relevant documents.
4. Determines work-item boundaries.
5. Extracts requirements and acceptance criteria.
6. Determines dependencies and execution order.
7. Chooses the delegation prompt for every work item.
8. Resolves model and thinking configuration.
9. Determines how completion should be recorded.
10. Identifies questions requiring user intervention.

### Step 3: resolve user intervention

Before starting workers, the orchestrator identifies issues such as:

- Ambiguous requirements
- Contradictory specifications
- Missing product decisions
- Required credentials
- Destructive migration choices
- Unclear ticket boundaries
- Missing model selection
- Unsupported thinking levels
- Unclear completion behavior

It groups related questions into `ask_me`.

After the user answers, the orchestrator updates and revalidates the plan. It repeats this process until no known user intervention remains.

### Step 4: finalize

The plan can be finalized only when:

- Every work item has a clear identity
- Work items are ordered
- Dependencies are consistent
- Requirements are recorded
- Every work item has a delegation prompt
- Every work item has an exact model
- Every work item has an exact thinking level
- Completion behavior is known
- No known user blockers remain

Finalizing the plan automatically begins execution.

### Step 5: execute a work item

For each item:

1. Create a new tmux window.
2. Start normal interactive Pi with the required model and thinking level.
3. Wait for the worker extension to connect.
4. Verify the worker’s actual model and thinking level.
5. Send one delegation prompt.
6. Wait for progress, a blocker, failure, or final report.
7. Review the final report.
8. Accept it or request a revision.
9. Record the completion comment.
10. Mark the item complete.
11. Gracefully stop the worker Pi.
12. Close its tmux window.
13. Start the next ready item.

### Step 6: finish

When every work item is complete:

1. Mark the run complete.
2. Close remaining workflow-owned resources.
3. Release the project lock.
4. Display the final workflow summary.

---

## 6. Internal plan

The orchestrator converts arbitrary source material into a normalized plan:

```ts
interface WorkflowPlan {
  summary: string;
  workItems: WorkItem[];
  userResolutions: UserResolution[];
  finalized: boolean;
}
```

Each item contains:

```ts
interface WorkItem {
  id: string;
  title: string;

  sourcePaths: string[];
  specificationPaths: string[];

  requirements: string[];

  order: number;
  orderReason: string;
  dependsOn: string[];

  delegationPrompt: string;
  launchProfile: PiLaunchProfile;

  completionStrategy: CompletionStrategy;
  status: WorkItemStatus;
}
```

The plan stores why the orchestrator chose the order:

```json
{
  "id": "repository-layer",
  "order": 2,
  "orderReason": "Requires the database schema and is needed by the API ticket.",
  "dependsOn": ["database-schema"]
}
```

The normalized plan—not ticket naming—is authoritative during execution.

---

## 7. Delegation prompts and Pi skills

Each work item stores its exact delegation prompt.

The user can provide a template:

```text
/implement this ticket {ticket} using the specifications at {specs}
```

Supported placeholders can include:

```text
{ticket}
{tickets}
{specs}
{requirements}
{userAnswers}
{workItemId}
{workItemTitle}
```

Example expansion:

```text
/implement this ticket @docs/tickets/authentication.md using
the specifications at @docs/specs/authentication.md
```

Because the worker runs as normal interactive Pi, the message passes through normal Pi input processing:

- Extension commands
- Prompt templates
- Skills
- Project instructions
- `AGENTS.md`
- Normal tools
- Normal permissions
- Normal session behavior

The worker receives exactly one planned work item.

---

## 8. Model and thinking configuration

The free-form prompt may define a default profile:

```text
Use openai/gpt-5.6-sol with high thinking.
```

It may also define overrides:

```text
Use openai/gpt-5.6-sol with high thinking by default.
For the migration ticket, use openai/gpt-5.6-terra with medium thinking.
```

The orchestrator converts this into:

```ts
interface PiLaunchProfile {
  model: string;
  thinking:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}
```

Every work item must have a resolved profile before execution.

If model or thinking is:

- Missing
- Ambiguous
- Unavailable
- Unsupported
- Incompatible with the selected model

the orchestrator asks the user before finalizing.

There is no fallback to:

- Pi’s saved default
- The orchestrator’s current model
- A similarly named model
- A lower thinking level
- Any available model

---

## 9. Worker launch and verification

The tmux controller starts Pi normally:

```bash
pi \
  --model openai/gpt-5.6-sol \
  --thinking high
```

The worker receives:

```text
MEPIE_WORKFLOW_ROLE=worker
MEPIE_WORKFLOW_RUN_ID=<run-id>
MEPIE_WORKFLOW_ITEM_ID=<work-item-id>
MEPIE_WORKFLOW_REQUESTED_MODEL=openai/gpt-5.6-sol
MEPIE_WORKFLOW_REQUESTED_THINKING=high
MEPIE_WORKFLOW_SOCKET=<socket-path>
```

The controller must ensure the child loads Ticket Flow:

- Through the installed Mepie package, or
- Through an explicit extension path during local development

The ticket prompt is not sent immediately.

During `session_start`, the worker extension reads:

```ts
ctx.model
ctx.thinkingLevel
```

It sends:

```ts
interface WorkerReadyEvent {
  type: "worker-ready";
  runId: string;
  workItemId: string;
  provider: string;
  model: string;
  thinking: PiThinkingLevel;
  sessionFile?: string;
}
```

The controller compares requested and actual values.

If they differ:

1. Do not send the ticket.
2. Record the mismatch.
3. Pause the work item.
4. Return the exact mismatch to the orchestrator.
5. Ask the user when it cannot be resolved automatically.

If Pi clamps the thinking level, that counts as a mismatch.

Only a verified worker receives the delegation prompt.

---

## 10. Role separation

### Orchestrator may

- Read tickets and specifications
- Analyze requirements
- Determine work-item boundaries
- Determine dependencies and order
- Ask the user questions
- Build and update the plan
- Spawn and control workflow-owned workers
- Wait for worker events
- Review structured reports
- Accept or request report revisions
- Comment and mark items complete
- Pause, resume, stop, and recover runs

### Orchestrator may not

- Implement tickets
- Edit application source code
- Run implementation tests
- Audit implementation code
- Fix worker changes
- Spawn workers outside workflow tools
- Control unrelated tmux windows

During execution, the extension should keep only read-only and workflow tools active for the orchestrator.

### Worker

The worker remains an unrestricted, normal coding agent.

It retains:

- All normal implementation tools
- Skills
- Prompt templates
- Project instructions
- Model behavior
- Normal TUI interaction
- Normal session persistence

The worker owns:

- Repository exploration
- Implementation
- Tests and checks
- Implementation decisions allowed by the ticket
- Blocker reporting
- Final report submission

---

## 11. Orchestrator tools

The orchestrator sees four workflow tools.

### `workflow_plan`

Manages preparation.

```ts
{
  action: "save" | "update" | "finalize";
  plan?: WorkflowPlan;
  changes?: PlanChange[];
}
```

Responsibilities:

- Save work items
- Change ordering
- Add or remove dependencies
- Store requirements
- Store delegation prompts
- Store model and thinking profiles
- Record user resolutions
- Validate the plan
- Finalize and begin execution

`finalize` fails if the plan is incomplete.

### `workflow_worker`

Controls the active Pi worker.

```ts
{
  action: "delegate" | "wait" | "read" | "send" | "close";
  workItemId: string;
  message?: string;
  until?:
    | "connected"
    | "ready"
    | "progress"
    | "report"
    | "blocked"
    | "idle"
    | "exit"
    | "any";
  timeoutMs?: number;
  lines?: number;
}
```

Actions:

- `delegate`: create window, spawn Pi, verify profile, send prompt
- `wait`: wait for a native worker event
- `read`: capture terminal content for observation
- `send`: send feedback to the worker’s Pi session
- `close`: gracefully stop the worker and close its tmux window

`wait` respects cancellation. Cancelling a wait does not kill the worker.

### `workflow_review_report`

Reviews submitted reports.

```ts
{
  action: "inspect" | "accept" | "revise" | "block";
  workItemId: string;
  comment?: string;
  feedback?: string;
  missingRequirements?: string[];
  questions?: string[];
}
```

Actions:

- `inspect`: retrieve the latest report
- `accept`: record completion, close worker, start next item
- `revise`: request a revised report from the same worker
- `block`: pause execution and record the blocker

### `workflow_control`

Controls the run.

```ts
{
  action: "status" | "pause" | "resume" | "stop" | "recover";
}
```

It returns:

- Run phase
- Original prompt
- Plan
- Active item
- tmux window
- Requested and actual model configuration
- Pending report
- Blockers
- Recent events

---

## 12. Worker tools

The Pi worker sees two workflow tools.

### `workflow_context`

```ts
{
  action: "get" | "wait-for-feedback";
  timeoutMs?: number;
}
```

`get` returns:

- Work-item ID and title
- Ticket paths
- Specification paths
- Requirements inferred by the orchestrator
- User resolutions
- Delegation prompt
- Requested model and thinking
- Actual model and thinking
- Expected report format

`wait-for-feedback` waits for:

- Report acceptance
- Report revision instructions
- User answers to blockers
- Workflow shutdown

### `workflow_submit_report`

```ts
{
  status: "progress" | "completed" | "blocked" | "failed";
  summary: string;
  requirements?: RequirementResult[];
  filesChanged?: string[];
  checks?: CheckResult[];
  caveats?: string[];
  blockers?: string[];
  questions?: string[];
}
```

This single tool submits:

- Progress heartbeats
- Completion reports
- Runtime blockers
- Failures

The worker never calls `workflow_review_report`.

---

## 13. Report contract

A completion report should contain:

```json
{
  "status": "completed",
  "summary": "Implemented single-use refresh-token rotation.",
  "requirements": [
    {
      "requirement": "Refresh tokens must be single-use",
      "result": "satisfied",
      "evidence": "Added token-family invalidation to the refresh service."
    }
  ],
  "filesChanged": [
    "src/auth/refresh-service.ts",
    "src/auth/refresh-service.test.ts"
  ],
  "checks": [
    {
      "command": "bun test",
      "result": "passed",
      "output": "148 tests passed"
    }
  ],
  "caveats": [],
  "blockers": []
}
```

The orchestrator checks whether:

- Every planned requirement appears
- Every requirement has a result
- Required validation was performed
- Failures are explained
- Caveats are explicit
- The report is internally consistent

This is report review, not code audit.

If the report is insufficient, the orchestrator calls:

```text
workflow_review_report(action: "revise")
```

The extension sends feedback into the same worker Pi session.

---

## 14. Native communication

The orchestrator creates a short Unix socket path:

```text
${TMPDIR}/mepie-ticket-flow/<run-id>.sock
```

The worker extension connects during `session_start`.

Messages include:

```ts
type WorkflowMessage =
  | WorkerConnected
  | WorkerReady
  | WorkerProgress
  | WorkerReport
  | WorkerBlocked
  | WorkerFailed
  | OrchestratorDelegate
  | OrchestratorFeedback
  | OrchestratorAccepted
  | OrchestratorShutdown;
```

### Delegation

After profile verification:

```ts
{
  type: "delegate";
  workItemId: "authentication";
  prompt: "/implement this ticket @tickets/auth.md using @specs/auth.md";
}
```

The worker extension calls:

```ts
pi.sendUserMessage(prompt);
```

### Feedback

For report revision:

```ts
{
  type: "report-feedback";
  feedback: "The report does not address token reuse prevention.",
  missingRequirements: ["Refresh tokens must be single-use"]
}
```

The worker extension injects this into the same Pi session.

### Shutdown

After acceptance, the orchestrator requests graceful shutdown. The tmux window closes only after the worker exits or a bounded shutdown timeout expires.

---

## 15. tmux lifecycle

Each work item gets one tmux window:

```text
tf-01-database
tf-02-repository
tf-03-api
```

Display names are sanitized and shortened.

The controller persists:

- tmux server/socket identity
- tmux session identity
- `window_id`
- `pane_id`
- Display name
- Work-item ID

It must never identify or close a window by display name alone.

Core operations:

- Create a detached or unfocused window
- Capture returned window and pane IDs
- Start Pi with argument arrays
- Inspect pane process state
- Capture output for diagnostics
- Gracefully stop Pi
- Kill only the owned window when necessary

No shell interpolation should be used for model names, paths, or prompts.

---

## 16. Runtime blockers

A worker reports a blocker with:

```text
workflow_submit_report
status: "blocked"
```

The orchestrator:

1. Persists the blocker.
2. Pauses automatic progression.
3. Determines whether existing context resolves it.
4. Uses `ask_me` if user intervention is required.
5. Records the answer.
6. Sends it to the same worker.
7. Resumes the work item.

The next ticket does not start while the current one remains blocked unless the orchestrator explicitly revises the plan.

Known blockers should be resolved before execution. This path handles unforeseen blockers.

---

## 17. Completion and comments

Workflow metadata is authoritative and lives outside the repository.

Every accepted item stores:

- Completion status
- Accepted report
- Orchestrator comment
- Completion timestamp
- Worker Pi session
- Model and thinking used
- Relevant source paths

Because ticket files have no required format, the default strategy is:

```ts
{ type: "ledger-only" }
```

This marks the internal item complete without modifying the project.

Optional completion strategies:

```ts
type CompletionStrategy =
  | { type: "ledger-only" }
  | { type: "append-markdown"; path: string }
  | { type: "frontmatter"; path: string; field: string; value: unknown }
  | { type: "rename-file"; from: string; to: string }
  | { type: "move-file"; from: string; to: string };
```

If the user expects ticket files to change, the orchestrator determines or asks for the correct strategy during preparation.

The controller—not the worker—applies completion changes.

---

## 18. Global state and Git isolation

Ticket Flow generates no workflow state inside the project.

Use Pi’s global agent directory through `getAgentDir()`:

```text
~/.pi/agent/state/ticket-flow/
└── <project-id>/
    └── <run-id>/
        ├── state.json
        ├── plan.json
        ├── events.jsonl
        └── reports/
            ├── authentication-attempt-1.json
            └── authentication-accepted.json
```

If `PI_CODING_AGENT_DIR` is configured, the state follows that location.

`<project-id>` is derived from a hash of the project’s canonical path. The readable path is also stored in run metadata.

File purposes:

- `state.json`: current workflow snapshot
- `plan.json`: normalized execution plan
- `events.jsonl`: append-only event history
- `reports/*.json`: worker reports

Security:

- State directories should use mode `0700`
- State files should use mode `0600`
- Socket files should be owner-only
- Large or sensitive terminal captures should not be persisted by default

Consequences:

- No `.mepie` directory
- No generated project files
- No `.gitignore` changes
- No accidental workflow-state commits

Only an explicitly selected completion strategy may modify ticket files.

---

## 19. State machine

Run phases:

```text
analyzing
awaiting-user
ready
executing
paused
completed
failed
stopped
```

Work-item states:

```text
planned
ready
spawning
verifying-worker
running
report-pending
report-review
report-revision
blocked
completed
failed
interrupted
```

Successful path:

```text
planned
→ ready
→ spawning
→ verifying-worker
→ running
→ report-pending
→ report-review
→ completed
```

Revision path:

```text
report-review
→ report-revision
→ running
→ report-pending
→ report-review
```

All transitions must be validated and idempotent.

---

## 20. Pause, stop, and recovery

### Pause

- Stop automatic progression
- Preserve the worker Pi process
- Preserve its tmux window
- Continue persisting incoming events

### Resume

- Reload run state
- Inspect the tmux window
- Restore the socket server
- Reconnect the worker extension
- Verify work-item identity
- Verify model and thinking
- Continue waiting or delegation

### Stop

After confirmation:

1. Send graceful shutdown to the worker.
2. Wait for exit.
3. Close the owned tmux window.
4. Mark the run stopped.
5. Release the project lock.
6. Preserve plans and reports.

### Recovery

When the extension starts:

1. Find unfinished global runs for the current project.
2. Check ownership locks.
3. Locate the recorded tmux window.
4. Recreate the workflow socket.
5. Request worker reconnection.
6. Verify run ID and work-item ID.
7. Verify model and thinking.
8. Recover pending reports.
9. Resume only when identity is certain.

If the state is ambiguous, pause and ask the user. Never launch a duplicate worker automatically.

---

## 21. Extension structure

```text
extensions/
└── ticket-flow/
    ├── index.ts
    ├── role.ts
    ├── domain.ts
    ├── config.ts
    ├── command.ts
    ├── controller.ts
    ├── state-store.ts
    ├── event-store.ts
    ├── completion.ts
    ├── orchestrator/
    │   ├── tools.ts
    │   └── system-prompt.ts
    ├── worker/
    │   ├── tools.ts
    │   └── lifecycle.ts
    ├── protocol/
    │   ├── messages.ts
    │   ├── server.ts
    │   └── client.ts
    └── tmux/
        └── controller.ts
```

Runtime dependencies and workflows should use Effect 4 for:

- Typed failures
- Resource scopes
- Socket lifecycle
- tmux process execution
- Cancellation
- Timeouts
- State serialization
- Sequential workflow execution

Long-lived resources start during `session_start` and close idempotently during `session_shutdown`.

---

## 22. Implementation plan

### Stage 1: domain and persistence

- Workflow types
- Work-item state machine
- Launch profiles
- Plan validation
- Global state paths
- Atomic JSON writes
- JSONL event log
- Project locking

### Stage 2: command and orchestrator mode

- `/ticket-flow tmux <prompt>`
- Original-prompt persistence
- Orchestrator system instructions
- Tool restriction
- `workflow_plan`
- `workflow_control`
- Automatic transition from planning to execution

### Stage 3: tmux and worker startup

- tmux detection
- Window creation
- Stable window and pane identity
- Normal Pi TUI launch
- Explicit model and thinking arguments
- Worker-role activation
- Startup failure handling

### Stage 4: native protocol

- Unix socket server
- Worker socket client
- Reconnection
- Worker identity
- Runtime model verification
- Native prompt delegation
- Native feedback delivery

### Stage 5: worker and report tools

- `workflow_context`
- `workflow_submit_report`
- Progress reporting
- Blocker reporting
- Completion reports
- Report persistence

### Stage 6: review and automatic progression

- `workflow_worker`
- `workflow_review_report`
- Report acceptance
- Report revision loop
- Completion comments
- Completion strategies
- Graceful worker shutdown
- Automatic next-ticket delegation

### Stage 7: recovery

- Pause, resume, and stop
- Extension reload recovery
- tmux reattachment
- Socket recreation
- Worker reconnection
- Duplicate-worker prevention
- Interrupted report recovery

### Stage 8: validation

Automated tests should cover:

- Arbitrary ticket plans
- Dependency validation
- Model mismatch
- Thinking-level clamping
- Worker connection timeout
- Report revision
- Runtime blocker handling
- State recovery
- Lock conflicts
- Accidental attempts to close unrelated tmux windows
- Global state remaining outside the repository

The first usable milestone is:

```text
/ticket-flow tmux <prompt>
+ Pi orchestrator
+ normal interactive Pi workers
+ exact model/thinking enforcement
+ native reporting and feedback
+ global non-Git state
+ sequential ticket execution
```

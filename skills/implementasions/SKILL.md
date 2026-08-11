---
name: implementasions
description: Orchestrate multiple implementation tickets through fresh managed Pi workers and verified hand-offs.
disable-model-invocation: true
compatibility: Requires git, tmux, and the terminal-environment workspace tool with managed Pi runs.
---

# Implementasions

You are the orchestrator. Prepare the queue, delegate every implementation, verify worker hand-offs, and maintain the orchestration ledger. Application-code implementation belongs to worker agents.

Use only fresh Pi Agent Runs created with `workspace` for worker work. Keep tickets sequential.

## AFK boundary

Phase 1 is the only interactive phase. Gather every user decision, confirmation, credential, and foreseeable blocker there, then obtain explicit approval to begin unattended work. The start of Phase 2 closes the boundary: Phases 2 and 3 run AFK through the final report, with no user questions or confirmation requests.

During AFK work, act as the user's proxy for worker questions. Resolve them from the spec, ticket clarifications, repository evidence, established conventions, and the smallest intent-preserving choice. Send the decision to the worker in a managed follow-up. When no safe resolution exists, mark the ticket blocked, record the exact unresolved decision, block its dependents, and continue any independent ready tickets. Never reopen Phase 1 after Phase 2 starts.

## Inputs and worker defaults

Obtain before unattended work starts:

- spec path
- ticket directory or explicit ticket paths
- reference paths
- repository/worktree path
- worker model and thinking level, when supplied

When the user omits the model, inspect `PI_PROVIDER` and `PI_MODEL` through `bash` and pass `{provider}/{model}` to `workspace run`. When thinking is omitted, choose it per assignment difficulty. Record both effective values returned by `workspace run`.

If required paths or worker settings cannot be resolved, collect them with all other preparation questions.

For worker prompts, use the repository/worktree `cwd` passed to `workspace run` as the path base. Render repository files as paths relative to that `cwd`; use absolute paths only for sources outside it. Never derive prompt paths from the orchestrator's shell `pwd`.

## Managed worker protocol

For every implementation ticket:

1. Call `workspace run` with `agent: "pi"`, the resolved model, chosen thinking level, repository `cwd`, and no target. A successful call creates the fresh tmux window and authoritative `runId`.
2. Require `processStarted: true` and `verifiedWorkFinished: true`. Treat unverified readiness as a failed launch; close the run when possible and retry or report the blocker.
3. Read [WORKER-PROMPTS.md](WORKER-PROMPTS.md), render the implementation template with `cwd`-based paths, scope, decisions, and report requirements, then call managed `workspace send` with `kind: "task"`, the `runId`, `input: "prompt"`, and the rendered text. Retain its `workId`.
4. Call managed `workspace wait` with the `runId` and `workId`. On timeout, wait again for the same work. Completion requires both Result Received and Work Finished; a raw signal or result text alone is not completion.
5. Accept, follow up, or block based on the reported outcome and the verification rules below. Start no other Work Cycle on that run before Work Finished.
6. Call `workspace close` with the `runId` after its assignment is accepted or abandoned. Record the lifecycle in the ledger.

A follow-up needed to complete the same assignment may use another managed Work Cycle on that run. A different ticket always gets a fresh run.

## Orchestration ledger

Create a durable, untracked ledger at a path returned by:

```bash
git rev-parse --git-path "implementasions/<session-id>.md"
```

Create its parent directory. Record:

- sources, resolved decisions, baseline HEAD, and baseline worktree status
- excluded, blocked, and queued tickets in execution order
- every run ID, work ID, assigned scope, effective model/thinking, outcome, and close status
- HEAD before each assignment and every accepted implementation commit SHA
- validation and code-review outcomes for each ticket

The ledger is the source of truth after context compaction. It is complete when another agent can reconstruct which changes and workers belong to this orchestration.

# Phase 1 — Preparation

1. Inspect every provided spec, ticket, reference file, and the relevant repository code. Identify every implementation ticket and its actual repository status.
2. Classify each ticket as `complete`, `partial`, `not implemented`, `blocked`, or `invalid/unclear`. Mark `complete` only when its required behavior and validation already pass.
3. Exclude verified-complete tickets. Keep partial tickets in scope with their remaining work stated explicitly.
4. Order remaining tickets by schema/migrations, shared contracts, prerequisites, dependencies, then dependents. Preserve the given order where no dependency requires a change.
5. Inspect git status and history. Record baseline HEAD and pre-existing changes. Resolve ownership of dirty files; any overlap or unclear ownership that could contaminate worker commits is a preparation blocker.
6. Collect every ambiguity, missing decision, invalid ticket, dependency blocker, credential need, confirmation, or AFK interruption risk. Ask all preparation questions together. Preparation is not complete while any ready ticket could predictably need user input.
7. Add concise clarification notes to affected ticket files after decisions resolve. Add only decisions, constraints, dependencies, and execution context; preserve original intent. Include these edits in the first relevant worker's commit rather than making an implementation commit yourself.
8. Initialize the ledger and present the classifications, queue, ordering reasons, blockers, notes added, baseline, and the AFK decision policy for anything unforeseen.
9. Ask for explicit confirmation to cross the AFK boundary and begin Phase 2. Resolve any response that changes scope or decisions before asking for confirmation again.

**Preparation gate:** all source files have been inspected; every ticket is classified; all foreseeable questions are resolved and written into the tickets; the ready queue, clean scope boundary, baseline, and proxy-decision policy are recorded; the user has explicitly approved unattended execution.

# Phase 2 — Implementation

For each queued ticket in order:

1. Record current HEAD and render the implementation template from [WORKER-PROMPTS.md](WORKER-PROMPTS.md). Include the exact ticket, spec, references, resolved notes, repository instructions, baseline exclusions, and expected validation.
2. Run the managed worker protocol. Delegate only this ticket. Do not edit application code or start the next ticket while it runs.
3. After an outcome of `completed`, minimally verify:
   - reported requirements and validation cover the ticket
   - the worker ran `code-review` against the pre-ticket HEAD, resolved valid findings, and reported passing Standards/Spec verdicts or justified minor exceptions
   - the ticket's repository-defined completion marker is updated
   - one or more new commits belong to this ticket and are reported by SHA
   - only ticket-owned files were committed; baseline/unrelated changes remain excluded
   - worktree state is understood and no failure was hidden
4. If verification fails, send the same worker a focused follow-up and wait again. Never repair the ticket yourself.
5. If the worker reports a question or blocker, apply the AFK proxy policy. Send a safe resolution to the same worker in a managed follow-up; otherwise record the ticket as blocked and close its run. Continue independent ready tickets.
6. Accept the ticket only after verification passes. Add its commit SHAs to the ledger, close the run, then start the next ticket.

Do not re-run excluded or accepted tickets. Change order only for a newly discovered dependency, missing/invalid ticket, or blocker; record the reason and continue autonomously. Keep all user-facing questions deferred to the final report.

**Ticket gate:** the managed work finished successfully, the ticket is marked complete, its validation passed, its commits and worktree effects are verified, and its run is closed.

# Phase 3 — Completion

Finish autonomously after every ready ticket passes its ticket gate or is conclusively blocked. Report:

- excluded, completed, blocked, and unresolved tickets
- execution order and any changes to it
- implementation commit SHAs
- validation and code-review results per ticket
- final repository/worktree status
- worker run outcomes and any operational failures
- final status: `PASS`, `BLOCKED`, or `FAILED`

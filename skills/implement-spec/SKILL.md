---
name: implement-spec
description: "Implement a specification in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The goal is a PR which implements the entire spec on a single branch.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for **maximum concurrency**.

## Steps

1. Read the spec and tickets. Read enough to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Use a **verifier subagent** to inspect the spec, every ticket, the task graph, and the relevant codebase. Identify blockers, missing dependencies, invalid blocking relationships, feasibility issues, unclear requirements or acceptance criteria, and unresolved user intent. If anything is unresolved, collect every question across all tickets and ask the user in one batch before continuing. Record the approved clarifications in the relevant tickets, then run the verifier again. Continue to step 4 only when every ticket is implementation-ready and the verifier reports no unresolved questions or blockers.

4. Create a branch, and a draft PR. The PR should be marked as 'closing' the spec issue and tickets.

5. Use **implementer subagents** to implement each ticket. Each implementer subagent should work in its own worktree, on its own branch.

6. Once an **implementer subagent** completes, merge its work to the PR branch with a **merger subagent**.

7. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

8. Once all tickets are complete, run /code-review on the PR branch. Fix all issues raised by the code review in a single **implementer subagent**.

9. Mark the PR as ready for review.

10. Clean up all **implementer subagent** worktrees.

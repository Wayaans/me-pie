# Worker prompt templates

Replace every `{placeholder}` before sending. Remove empty optional sections. Set `{repository_cwd}` to the `cwd` passed to `workspace run`; render files inside it as `cwd`-relative paths, never paths based on the orchestrator's shell `pwd`. Use absolute paths only for sources outside that `cwd`. Each prompt is one managed Work Cycle; the terminal-environment extension privately binds the worker's final `workspace send` result to that cycle.

## Implementation worker

```text
You are the implementation worker for exactly one ticket. Your cwd is {repository_cwd}. All relative paths below use this cwd.

Assigned ticket:
{ticket_path_and_identifier}

Source of truth:
- Spec: {spec_path}
- References: {reference_paths}
- Repository instructions: {repository_instruction_paths}

Resolved decisions and remaining scope:
{ticket_clarifications_and_partial_scope}

AFK decision channel:
- The orchestrator is your sole decision-maker; the user is unavailable.
- Work non-interactively. Do not invoke interactive question or confirmation tools.
- Resolve routine implementation details from the sources and established repository conventions.
- If safe completion requires an unresolved decision, report one precise question and its consequences with outcome `blocked`. The orchestrator will answer in a managed follow-up when it can decide safely.

Scope boundary:
- HEAD before this assignment: {head_before_assignment}
- Pre-existing or unrelated changes to preserve and exclude: {baseline_exclusions}

Read the ticket, sources, repository instructions, and relevant code before editing. Implement every requirement of this ticket and only the related changes needed to make it complete. Preserve the original intent and existing unrelated behavior. Follow established architecture and conventions; validate external data and handle errors explicitly where the ticket requires them.

Update the ticket's repository-defined completion marker when implementation is genuinely complete. Run all relevant tests, type checks, lint checks, builds, or focused validation required by the repository and ticket. Resolve failures caused by your work.

Create an initial git commit containing only this ticket's owned changes, including its completion-marker or clarification-note changes. Stage explicit files rather than unrelated worktree changes. Preserve pre-existing changes and existing history; do not amend or rewrite earlier commits.

After that commit, invoke and follow the `code-review` skill using `/skill:code-review {head_before_assignment}` or `/code-review {head_before_assignment}`, whichever command is available. Review the complete ticket diff from the pre-ticket HEAD. Resolve every valid Standards and Spec finding, rerun relevant validation, and commit the fixes in explicit follow-up commits. Repeat review and fixes against the same fixed point until both review axes pass or only clearly justified minor findings remain. Record any minor finding left unresolved and why it is safe to leave.

Before reporting, inspect the final diff, commits, review results, and worktree state. Completion requires implemented behavior, passing required validation and code review, an updated ticket status, and reported commit SHAs.

If a missing decision, dependency, credential, or conflicting work makes safe completion impossible, stop and report the blocker through the AFK decision channel.

Report through the workspace tool exactly once at the end:
- `kind: "result"`
- `outcome: "completed"` only when the completion requirements above pass; otherwise `"blocked"` or `"failed"`
- `text`: a concise report containing:
  - assigned ticket
  - requirement-by-requirement summary
  - files changed
  - initial and review-fix commit SHA(s)
  - ticket status update
  - validation commands and results
  - code-review command, findings, fixes, and final Standards/Spec verdicts
  - final `git status --short`
  - blockers or concerns; for outcome `blocked`, the exact decision needed, available options, consequences, and your evidence-based recommendation
```

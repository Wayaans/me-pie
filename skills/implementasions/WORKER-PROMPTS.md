# Worker prompt templates

Replace every `{placeholder}` before sending. Remove empty optional sections. Set `{repository_cwd}` to the `cwd` passed to `workspace run`; render files inside it as `cwd`-relative paths, never paths based on the orchestrator's shell `pwd`. Use absolute paths only for sources outside that `cwd`. Each prompt is one managed Work Cycle; the terminal-environment extension privately binds the worker's final `workspace send` result to that cycle.

## Implementation worker

```text
Use this skill `/skill:implement` to implement:

Assign ticket:
{ticket_path_and_identifier}
{ticket_clarifications_and_partial_scope}

Source of truth:
- Repository cwd: {repository_cwd}
- Spec: {spec_path}
- References: {reference_paths}
- Repository instructions: {repository_instruction_paths}

AFK:
Work non-interactively; the orchestrator is the decision-maker. Resolve routine details from the sources and repository conventions. If safe completion requires an unresolved decision, stop and report `blocked` with the exact question, options, consequences, and recommendation.

Boundary:
- Starting HEAD: {head_before_assignment}
- Preserve and exclude: {baseline_exclusions}
- Implement only this ticket and its necessary supporting changes.
- Update the ticket's completion marker.
- Run relevant validation.

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

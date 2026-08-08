# Mepie

Mepie packages Pi extensions and agent resources. Ticket Flow coordinates a durable, sequential implementation workflow without hiding planning or completion decisions.

## Ticket Flow language

**Run**:
One durable Ticket Flow execution for a project, from confirmed setup through a clean audit or terminal cancellation.
_Avoid_: Workflow, job

**Ticket**:
One ordered Markdown implementation instruction selected during setup.
_Avoid_: Work item, task

**Assignment**:
One implementation, audit, or fix responsibility prepared for exactly one Worker.
_Avoid_: Ticket when referring to generated audit or fix work

**Worker**:
One persisted Pi session executing the active Assignment in an owned tmux window.
_Avoid_: Agent, pane

**Report**:
An immutable, identity-bound structured statement submitted by a Worker for one settled turn.
_Avoid_: Completion, result

**Audit Round**:
One read-only verification of the exact accepted commit set, producing either Findings or a clean verdict.
_Avoid_: Review

**Finding**:
A structured defect reported by an Audit Round and assigned to a Fixer.
_Avoid_: Comment, issue

**Fixer**:
A Worker assigned the Findings from one Audit Round.
_Avoid_: Repair agent

**Pause**:
A reversible block on new Run progression; an active Worker may finish its current turn.
_Avoid_: Freeze

**Abort**:
Cancellation of only the active Worker turn while preserving its Pi session for resume.
_Avoid_: Stop, cancel

**Stop**:
Terminal cancellation of a Run, including verified closure of its owned Worker.
_Avoid_: Abort

**Completion convention**:
A Ticket is complete only when it contains at least one Markdown task-list checkbox and every such checkbox is checked.
_Avoid_: Completion strategy

## Terminal Environment language

**Environment**:
The active terminal multiplexer that owns addressable terminal targets.
_Avoid_: Backend when discussing user-visible terminal behavior

**Target**:
One addressable terminal object, such as a tmux session, window, or pane.
_Avoid_: Worker, terminal when the exact addressable object matters

**Agent Run**:
One coding-agent process launched in a Target.
_Avoid_: Worker, Assignment

**Delivery**:
One literal prompt or command successfully sent to a Target.
_Avoid_: Message when referring to terminal input

**Send Signal**:
A sequenced notification written to the destination Target's inbox after a successful Delivery and attributed to the source Target. Workspace wait listens on the requested recipient Target's inbox and reports the source of the next signal. In the report protocol, the Agent Run emits this signal only after finishing its task and delivering its report to the controller pane.
_Avoid_: Independently verified completion, because the signal records the Agent Run's report rather than inspecting process state

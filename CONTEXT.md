# Mepie

Mepie packages Pi extensions and agent resources.

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

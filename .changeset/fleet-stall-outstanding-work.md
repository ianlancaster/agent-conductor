---
'agent-conductor': patch
---

Ask whether any work is in flight before declaring a fleet stall. Roster activity answers "is any
seat typing", which is a different question: a seat can read idle at its prompt while a build, test
run, or tool subprocess it launched keeps running underneath, holding no tty and owning no
foreground process group. At the moment a fleet stall would otherwise fire — on the confirmation
path only, never on the heartbeat — Conductor now samples cumulative CPU across each running seat's
process tree twice a second apart. A seat above the threshold suppresses the alert, is named in the
health log and in a new `suppressed-work-in-flight` disposition on `fleet.stalled`, and the watch
re-arms rather than latching, so the alert still fires once the work finishes.

Counting descendant processes instead is wrong and was measured to be wrong. Idle seats are not at
zero, and what sits beneath them — `caffeinate`, stdio MCP servers — is indistinguishable from a
build by count, so `descendants > 0` would suppress fleet stall permanently on any seat with an MCP
server attached: an instrument that can never fire. The threshold is set from a live measurement,
an order of magnitude above the observed idle ceiling and an order of magnitude below one saturated
core.

The term can only suppress a fleet stall, never cause one, which is what makes an unreadable probe
safe to proceed through: the stall is still reported, and the report says the probe was
inconclusive and names the seat rather than silently claiming the fleet was quiet. `TerminalBackend`
gains an optional `paneShellPid`; a backend that cannot expose one yields unknown, not an empty
tree.

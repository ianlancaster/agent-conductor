---
'@ianlancaster/agent-conductor': patch
---

Make `get_conductor_docs` state which build its handbook actually reflects. The guide is read from
disk at call time while the running Conductor is the build that was loaded at startup, so a package
root linked to a checkout served documentation for code the live process did not have — and the tool
name promised version-matching while delivering checkout-matching. That failure is not a missed
alert: a reader can retire a workaround because the document says its replacement shipped. Every
response now carries a `build` block with the version, the handbook and build timestamps, and
`reflectsRunningBuild`, plus an explicit warning when the handbook is newer than the running build.

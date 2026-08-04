---
'agent-conductor': patch
---

Stop session and supervisor configuration from diverging silently from the running fleet. A start,
continue, or restart now re-reads session files before launching, so an operator who edits YAML and
immediately restarts no longer relaunches the configuration from the last mtime poll and gets no
indication the edit was ignored. Supervisor settings still require a restart by design, but a
changed `supervisor.yaml` now warns the operator once per change instead of leaving the file and the
running process disagreeing in silence — a fleet whose file reads `defaults.auto: true` while every
session registered since boot is unsupervised has no other way to notice.

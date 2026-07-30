---
'agent-conductor': minor
---

Give a session's launch facts the same currency its declaration already had

A session config is trivially readable and always current; the launch was recorded only in the event
journal, which nothing surfaced. So the cheap read was the wrong read, and three separate agents
reported a config value as a running value in one evening. The failure is not carelessness — it is
that Conductor represented the value perfectly and never represented _when it took effect_.

- `get_session_status` gains `effortDeclared` beside `effort`, matching the existing `modelDeclared`
  split, and `launchedAt` — when the live process actually started. Null while stopped, and null for a
  process adopted from before launches were recorded, because an unobserved launch must not be
  reported as a known one.
- The Claude Code status line installed by `conductor statusline` now prints context used as a
  percentage of the runtime's own reported `context_window_size` — `13% of 1.0M` rather than `13%`. A
  model's display name cannot distinguish variants that differ only in context size, so a bare
  percentage left its denominator unknowable from the pane, and the window had to be inferred from the
  model name to be used at all. It is omitted rather than guessed when the runtime reports none.

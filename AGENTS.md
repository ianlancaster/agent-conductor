# Agent instructions

Before inspecting, planning, or changing code, read and follow:

1. [CLAUDE.md](CLAUDE.md) — the canonical architecture and agent guide.
2. [CONTRIBUTING.md](CONTRIBUTING.md) — the product, quality, documentation, and
   completion contract.

This is mandatory for Claude Code, Codex, and every other coding agent working on
Agent Conductor. Do not treat this repository as one operator's fleet configuration:
it is a public, reusable product. Changes must be general, legible, configurable where
real users need variation, and complete across every applicable core, adapter, command,
help, prompt, test, and documentation surface. Maintain a primitive-first,
adapter-driven, anti-gold-plating stance: prefer the smallest composable capability that
serves multiple workflows, and decline narrow features that dilute the core. Apply the
concrete [contributor feature bar](CONTRIBUTING.md#feature-bar-primitive-first-composable-and-minimal)
to every feature request.

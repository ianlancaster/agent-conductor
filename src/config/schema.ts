import { z } from 'zod';

/** Codenames become URL path segments, filenames, and tmux targets — keep them boring. */
export const CODENAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;

export function isValidCodename(value: string): boolean {
  return CODENAME_PATTERN.test(value);
}

export const scheduleEntrySchema = z.object({
  label: z.string().optional(),
  cron: z.string(),
  prompt: z.string(),
  paused: z.boolean().default(false),
  freshSession: z.boolean().default(false),
});

export const agentConfigSchema = z.object({
  codename: z.string().min(1).regex(CODENAME_PATTERN, 'codename must be alphanumeric with dashes/underscores'),
  /** Human-readable display name. Defaults to the codename. */
  agent: z.string().optional(),
  /** Absolute or config-relative path to the agent's working directory. */
  repo: z.string().min(1),
  runtime: z.enum(['claude-code', 'codex']).default('claude-code'),
  model: z.string().optional(),
  additionalDirs: z.array(z.string()).default([]),
  /**
   * Per-agent instructions appended to this agent's system prompt, on top of the
   * conductor protocol every agent receives. Point the sentinel at the shipped
   * sentinel prompt here. Absolute, or resolved relative to the config dir.
   */
  systemPromptFile: z.string().optional(),
  schedules: z.array(scheduleEntrySchema).default([]),
});

export const supervisorConfigSchema = z.object({
  supervisor: z
    .object({
      heartbeatIntervalSeconds: z.number().int().positive().default(30),
      logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .default({}),
  paths: z
    .object({
      dataDir: z.string().default('./data'),
    })
    .default({}),
  mcp: z
    .object({
      /** Default: derived per fleet dir (stable hash into 3456..3955) so multiple conductors don't collide. */
      port: z.number().int().positive().optional(),
      host: z.string().default('127.0.0.1'),
      keepAliveTimeoutMs: z.number().int().positive().default(60_000),
    })
    .default({}),
  health: z
    .object({
      /** Pane lines captured per check and attached to stall events. */
      captureLines: z.number().int().positive().default(40),
      /** Unchanged heartbeats before the fallback watchdog flags a silent stall. */
      stallBeatsThreshold: z.number().int().positive().default(2),
      /** Quiet period after a runtime `stop` event before it becomes an idle stall. */
      idleConfirmMs: z.number().int().nonnegative().default(15_000),
      /** Window in which similar stalls are suppressed as duplicates. */
      suppressWindowMs: z.number().int().positive().default(300_000),
      /** Content similarity (0..1) above which a repeat stall is suppressed. */
      suppressSimilarity: z.number().min(0).max(1).default(0.8),
      /** With lifecycle events flowing, how stale events must be before pane-diffing kicks in. */
      eventSilenceMs: z.number().int().positive().default(120_000),
    })
    .default({}),
  messaging: z
    .object({
      queueDrainMs: z.number().int().positive().default(2_000),
      queueMaxAgeMs: z.number().int().positive().default(60_000),
      tailDefaultLines: z.number().int().positive().default(30),
      tailMaxLines: z.number().int().positive().default(500),
    })
    .default({}),
  defaults: z
    .object({
      autonomy: z.enum(['facilitated', 'autonomous']).default('facilitated'),
      placement: z.enum(['pane', 'tab', 'window']).default('pane'),
    })
    .default({}),
  sentinel: z
    .object({
      /** Codename of the designated stall sentinel. Autonomous mode requires one. */
      codename: z.string().optional(),
    })
    .default({}),
  terminal: z
    .object({
      backend: z.enum(['iterm', 'tmux']).default('iterm'),
      /** Default: "Agent Conductor (<fleet dir name>)" so multiple fleets are distinguishable. */
      windowName: z.string().optional(),
      iterm: z
        .object({
          autoPauseOnFocus: z.boolean().default(false),
          autoPauseResumeDelaySeconds: z.number().int().positive().default(60),
          focusCheckMs: z.number().int().positive().default(5_000),
          bracketedPasteThreshold: z.number().int().positive().default(512),
          launchTimeoutSec: z.number().positive().default(8),
          pollIntervalSec: z.number().positive().default(0.25),
        })
        .default({}),
      tmux: z
        .object({
          /** Default: "conductor-<fleet slug>" so multiple fleets don't share one tmux session. */
          sessionName: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
  channels: z
    .object({
      telegram: z
        .object({
          /** Token/chat id come from env: CONDUCTOR_TELEGRAM_TOKEN / CONDUCTOR_TELEGRAM_CHAT_ID. */
          enabled: z.boolean().default(true),
          panePreviewLines: z.number().int().positive().default(20),
        })
        .default({}),
    })
    .default({}),
  runtimes: z
    .object({
      claudeCode: z
        .object({
          binary: z.string().default('claude'),
          defaultModel: z.string().optional(),
          autocompactPct: z.number().int().min(1).max(100).default(70),
          skipPermissions: z.boolean().default(true),
          /** Extra env vars exported to every agent. Values here override the built-in defaults. */
          env: z.record(z.string()).default({}),
          /** Path to the conductor protocol prompt appended to every agent's system prompt. */
          systemPromptFile: z.string().optional(),
        })
        .default({}),
      codex: z
        .object({
          binary: z.string().default('codex'),
          defaultModel: z.string().optional(),
          /** MCP tool timeout — Codex defaults to 60s, far too low for long consults. */
          toolTimeoutSec: z.number().int().positive().default(600),
        })
        .default({}),
    })
    .default({}),
  spawn: z
    .object({
      /** Directory pattern for spawned agents; {codename} is substituted. */
      dirPattern: z.string().default('../{codename}'),
      /** Marker file that flags a repo as an "agent" project (display-only). */
      markerFile: z.string().default('.conductor-agent'),
    })
    .default({}),
  scheduler: z
    .object({
      reloadIntervalBeats: z.number().int().positive().default(10),
    })
    .default({}),
});

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Raw parse output — instance-scoped fields may be absent (loader derives them per fleet dir). */
export type SupervisorConfigInput = z.infer<typeof supervisorConfigSchema>;

/** Fully-resolved config: the loader fills port/windowName/sessionName from per-fleet derivation. */
export type SupervisorConfig = Omit<SupervisorConfigInput, 'mcp' | 'terminal'> & {
  mcp: SupervisorConfigInput['mcp'] & { port: number };
  terminal: Omit<SupervisorConfigInput['terminal'], 'windowName' | 'tmux'> & {
    windowName: string;
    tmux: SupervisorConfigInput['terminal']['tmux'] & { sessionName: string };
  };
};

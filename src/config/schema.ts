import { z } from 'zod';

export const DEFAULT_CLAUDE_CODE_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const;

export const DEFAULT_CODEX_MODELS = [
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4',
  'gpt-5.3-codex-spark',
] as const;

export const DEFAULT_CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const DEFAULT_CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export const DEFAULT_SPAWN_TEMPLATES = {
  agent: {
    source: 'https://github.com/ianlancaster/cognitive-agent-template',
  },
} as const;

export const DEFAULT_MAX_TAG_LENGTH = 50;

/**
 * Values Claude Code accepts for `askUserQuestionTimeout`, version-matched to
 * 2.1.220. Validated rather than passed through: an unrecognized value silently
 * resolves to `never`, which is the indefinite park this setting exists to
 * prevent, so a typo would reinstate the defect while looking configured.
 */
export const ASK_USER_QUESTION_TIMEOUTS = ['60s', '5m', '10m', 'never'] as const;

const stringHints = (defaults: readonly string[]) => z.array(z.string().trim().min(1)).default([...defaults]);
/** Codenames become URL path segments, filenames, and tmux targets — keep them boring. */
export const CODENAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;

export function isValidCodename(value: string): boolean {
  return CODENAME_PATTERN.test(value);
}

/** Runtime names are resolved against Supervisor's final built-in + injected registry. */
export const runtimeSchema = z.string().trim().min(1, 'runtime must be a non-empty name');

export const scheduleEntrySchema = z
  .object({
    label: z.string().optional(),
    cron: z.string(),
    prompt: z.string(),
    paused: z.boolean().default(false),
    freshContext: z.boolean().default(false),
  })
  .strict();

export const spawnTemplateSchema = z
  .object({
    /** Git clone-compatible URL or path. Relative paths resolve from the fleet directory. */
    source: z.string().trim().min(1),
    /** Optional branch, tag, or commit checked out after cloning. */
    ref: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !value.startsWith('-'), 'template ref must not begin with a dash')
      .optional(),
  })
  .strict();

export const configuredIntegrationSchema = z
  .object({
    /** Absolute or fleet-root-relative path to one trusted executable ESM module. */
    module: z.string().trim().min(1, 'integration module must be a non-empty file path'),
    /** Opaque plugin-owned configuration. Conductor validates only that it is a mapping. */
    options: z.record(z.unknown()).default({}),
  })
  .strict();

export const sessionConfigSchema = z
  .object({
    codename: z.string().min(1).regex(CODENAME_PATTERN, 'codename must be alphanumeric with dashes/underscores'),
    /** Absolute or config-relative path to the session's working directory. */
    repo: z.string().min(1),
    runtime: runtimeSchema.default('claude-code'),
    /** Override the fleet default for approval/sandbox bypass when this session launches. */
    bypassPermissions: z.boolean().optional(),
    model: z.string().optional(),
    /** Per-session effort default. Runtime/model support is intentionally not validated here. */
    effort: z.string().min(1).optional(),
    /**
     * Declared stall-routing policy for this session, applied when it is first
     * registered — including at spawn — and whenever no per-session state has
     * been persisted yet. `toggle_auto` remains the runtime control and its
     * value persists, so a live change is never undone by a config reload.
     * Declaring it here is what makes a unit's policy durable and reviewable in
     * version control rather than dependent on the fleet default in force at
     * the moment Conductor happened to boot.
     */
    auto: z.boolean().optional(),
    additionalDirs: z.array(z.string()).default([]),
    /**
     * Short-lived worker rather than a standing member of this fleet. Sessions
     * created by `spawn_session` are ephemeral by default; hand-authored configs
     * are standing unless they say otherwise. Fleet watch measures the standing
     * roster only, so a burst of pods cannot silently disarm it and a pod
     * finishing its task cannot look like the fleet going dark.
     */
    ephemeral: z.boolean().default(false),
    /**
     * Per-session durable role instructions, appended after the conductor protocol and
     * retained across runtime compaction. Maximum 5 KiB UTF-8. Absolute, or resolved
     * relative to the fleet root.
     */
    systemPromptFile: z.string().trim().min(1).optional(),
    /**
     * Override the fleet's Claude Code question auto-continue timeout for this
     * session. **Claude Code only** — Codex has no equivalent, and Conductor
     * warns rather than silently ignoring it on a session of another runtime.
     */
    askUserQuestionTimeout: z.enum(ASK_USER_QUESTION_TIMEOUTS).optional(),
    schedules: z.array(scheduleEntrySchema).default([]),
  })
  .strict();

export const supervisorConfigSchema = z
  .object({
    supervisor: z
      .object({
        heartbeatIntervalSeconds: z.number().int().positive().default(30),
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        /** Maximum Unicode characters accepted for a session status tag. */
        maxTagLength: z.number().int().positive().default(DEFAULT_MAX_TAG_LENGTH),
      })
      .strict()
      .default({}),
    paths: z
      .object({
        dataDir: z.string().default('./.conductor/data'),
      })
      .strict()
      .default({}),
    runbooks: z
      .object({
        /** Additional local bundle directories or collections, resolved from the fleet directory. */
        paths: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({}),
    events: z
      .object({
        journal: z
          .object({
            /** Append the content-free typed event stream to the local SQLite store. */
            enabled: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Trusted local executable modules loaded only by the stock foreground CLI. */
    integrations: z.array(configuredIntegrationSchema).default([]),
    mcp: z
      .object({
        /** Default: derived per fleet dir (stable hash into 3456..3955) so multiple conductors don't collide. */
        port: z.number().int().positive().optional(),
        host: z.string().default('127.0.0.1'),
        keepAliveTimeoutMs: z.number().int().positive().default(60_000),
      })
      .strict()
      .default({}),
    health: z
      .object({
        /** Pane lines captured per check and attached to stall events. */
        captureLines: z.number().int().positive().default(40),
        /** Unchanged heartbeats before the fallback watchdog flags a silent stall. */
        stallBeatsThreshold: z.number().int().positive().default(2),
        /** Quiet period after a runtime `stop` event before it becomes an idle stall. */
        idleConfirmMs: z.number().int().nonnegative().default(15_000),
        /** Confirmation period after every registered non-sentinel session becomes non-working. */
        fleetStallConfirmMs: z.number().int().nonnegative().default(15_000),
        /** Window in which similar stalls are suppressed as duplicates. */
        suppressWindowMs: z.number().int().positive().default(300_000),
        /** Content similarity (0..1) above which a repeat stall is suppressed. */
        suppressSimilarity: z.number().min(0).max(1).default(0.8),
        /** Quiet period before pane-silence fallback for runtimes without authoritative completion events. */
        eventSilenceMs: z.number().int().positive().default(120_000),
      })
      .strict()
      .default({}),
    messaging: z
      .object({
        queueDrainMs: z.number().int().positive().default(2_000),
        /**
         * Whether sessions may raise *selectable* operator requests — a
         * `send_to_operator` call carrying `options`, which creates a durable
         * pending row a human must resolve.
         *
         * Set `false` on a fleet whose policy is that agents must not put a
         * human decision in front of themselves: the call is then refused before
         * any row or event exists, and the refusal names prose as the route that
         * remains. Prose-only `send_to_operator` is unaffected either way, as are
         * existing rows and every read path over them. Defaults to `true` so no
         * fleet loses the capability without asking.
         */
        allowOperatorRequestOptions: z.boolean().default(true),
        /** @deprecated Retained for config compatibility; occupied input is never force-delivered over. */
        queueMaxAgeMs: z.number().int().positive().default(60_000),
        tailDefaultLines: z.number().int().positive().default(30),
        tailMaxLines: z.number().int().positive().default(500),
        /**
         * How long a recipient's queue may fail to drain before the operator is
         * told. Measured as elapsed time rather than backlog: backlog is a proxy
         * for how busy the fleet is, not for how long delivery has been down,
         * and it trips later the quieter the fleet gets.
         */
        undeliverableWarnMs: z.number().int().nonnegative().default(600_000),
        /**
         * The same clock for the sentinel, whose blocked queue means fleet-wide
         * stall routing is undelivered rather than one seat being stuck.
         */
        sentinelUndeliverableWarnMs: z.number().int().nonnegative().default(120_000),
      })
      .strict()
      .default({}),
    defaults: z
      .object({
        auto: z.boolean().default(false),
        runtime: runtimeSchema.default('claude-code'),
        /** Launch sessions without approval prompts or sandbox restrictions. */
        bypassPermissions: z.boolean().default(true),
        placement: z.enum(['pane', 'tab', 'window']).default('pane'),
      })
      .strict()
      .default({}),
    sentinel: z
      .object({
        /** Initial stall sentinel. The persisted set_sentinel choice overrides it. */
        codename: z.string().optional(),
      })
      .strict()
      .default({}),
    shepherd: z
      .object({
        enabled: z.boolean().default(false),
        configPath: z.string().min(1).nullable().default(null),
        presentation: z.enum(['headless', 'panel']).default('headless'),
      })
      .strict()
      .default({}),
    terminal: z
      .object({
        /** Default: auto-detected — tmux when the conductor is launched inside tmux ($TMUX), else iterm on macOS, tmux elsewhere. */
        backend: z.enum(['iterm', 'tmux']).optional(),
        /** Default: "Agent Conductor (<fleet dir name>)" so multiple fleets are distinguishable. */
        windowName: z.string().optional(),
        iterm: z
          .object({
            /** Watermark the session codename as an iTerm badge (the big red text). */
            badge: z.boolean().default(true),
            bracketedPasteThreshold: z.number().int().positive().default(512),
            launchTimeoutSec: z.number().positive().default(8),
            pollIntervalSec: z.number().positive().default(0.25),
          })
          .strict()
          .default({}),
        tmux: z
          .object({
            /** Default: "conductor-<fleet slug>" so multiple fleets don't share one tmux session. */
            sessionName: z.string().optional(),
            /**
             * When the conductor is launched from inside tmux, put session panes in
             * the launching window (splits/new windows in YOUR tmux session), like
             * the iTerm backend does. Set false to always use the detached
             * `sessionName` session instead.
             */
            attachToCurrent: z.boolean().default(true),
            /**
             * Show each pane's title ("codename — tag") in a border line above it,
             * by enabling tmux's pane-border-status on windows the conductor puts
             * panes into. tmux hides pane titles by default, which makes a fleet
             * unidentifiable. Set false to leave the window's border style alone.
             */
            paneBorders: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    channels: z
      .object({
        telegram: z
          .object({
            /** Token/chat id come from env: CONDUCTOR_TELEGRAM_TOKEN / CONDUCTOR_TELEGRAM_CHAT_ID. */
            enabled: z.boolean().default(false),
          })
          .strict()
          .default({}),
        slack: z
          .object({
            /** Credentials come from CONDUCTOR_SLACK_* values in the fleet environment. */
            enabled: z.boolean().default(false),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    runtimes: z
      .object({
        claudeCode: z
          .object({
            binary: z.string().default('claude'),
            defaultModel: z.string().optional(),
            /** Discoverability hints only; model overrides are deliberately not validated against this list. */
            availableModels: stringHints(DEFAULT_CLAUDE_CODE_MODELS),
            /** Fleet default for Claude Code launches; omit to let Claude Code choose. */
            defaultEffort: z.string().min(1).optional(),
            /** Discoverability hints only; model support varies and unknown values pass through. */
            availableEfforts: stringHints(DEFAULT_CLAUDE_CODE_EFFORTS),
            autocompactPct: z.number().int().min(1).max(100).default(70),
            /**
             * Context window, in tokens, that Claude Code's auto-compaction
             * threshold is computed against. It must be set for `autocompactPct`
             * to have any effect at all: Claude Code only consults the percentage
             * when a window has been configured explicitly, so a percentage on its
             * own leaves auto-compaction off — measured at 157,995 tokens against a
             * 9,000-token threshold with zero compactions.
             *
             * The default is deliberately the largest supported value. Claude Code
             * clamps it and then takes the minimum against the model's real window,
             * so the maximum arms the gate on every seat without shrinking any of
             * them, while a smaller number would silently truncate large-window
             * sessions. Lower it only to force earlier compaction on purpose.
             */
            autocompactWindowTokens: z.number().int().min(100_000).max(1_000_000).default(1_000_000),
            /** Export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 (disable if it breaks tools you rely on). */
            disableNonessentialTraffic: z.boolean().default(true),
            /** Strip Claude Code's optional UI chrome from panes: spinner tips, prompt suggestions, onboarding/startup hints. */
            bareUi: z.boolean().default(true),
            /**
             * How long an unanswered `AskUserQuestion` prompt waits before the
             * session continues on its own.
             *
             * Claude Code's own default is `never`, which parks a managed seat
             * indefinitely: the prompt blocks the turn, Conductor cannot answer it
             * (typing into a selection menu answers a question nobody asked
             * Conductor to answer), and the seat holds a `blocked` stall until a
             * human arrives. Observed once as an 11.5-hour fleet stall.
             *
             * Conductor defaults to `5m` instead. That still lets an agent ask a
             * real question and get a real answer from an attentive operator, and
             * it bounds the damage when nobody is there. Set `never` to restore the
             * runtime's own behavior on a fleet that is always attended.
             */
            askUserQuestionTimeout: z.enum(ASK_USER_QUESTION_TIMEOUTS).default('5m'),
            /** Extra env vars exported to every session. Values here override the built-in defaults. */
            env: z.record(z.string()).default({}),
          })
          .strict()
          .default({}),
        codex: z
          .object({
            binary: z.string().default('codex'),
            defaultModel: z.string().optional(),
            /** Discoverability hints only; custom providers may support additional model IDs. */
            availableModels: stringHints(DEFAULT_CODEX_MODELS),
            /** Fleet default for Codex launches; omit to let Codex choose. */
            defaultEffort: z.string().min(1).optional(),
            /** Discoverability hints only; model/provider support varies and unknown values pass through. */
            availableEfforts: stringHints(DEFAULT_CODEX_EFFORTS),
            /** MCP tool timeout — Codex defaults to 60s, far too low for long consults. */
            toolTimeoutSec: z.number().int().positive().default(600),
            /**
             * Strip Codex's optional UI chrome and non-essential traffic: startup
             * update check (an interactive prompt that would hang a spawned pane),
             * analytics, startup tips, animations, and terminal-title writes
             * (which would clobber the conductor's pane titles).
             */
            bareUi: z.boolean().default(true),
            /**
             * Trust every hook discovered by Codex for this managed invocation so generated
             * lifecycle and post-compaction hooks run unattended. Set false to require manual
             * review when shared-config, repository, or plugin hook sources are not all trusted.
             */
            bypassHookTrust: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    spawn: z
      .object({
        /** Directory pattern for spawned sessions, relative to the fleet dir; {codename} is substituted. */
        dirPattern: z.string().default('./{codename}'),
        /** Marker file that flags a repo as an agent project (display-only 🤖). */
        markerFile: z.string().default('.agent-marker'),
        /** Registered Git-backed workspace templates selectable by name at spawn time. */
        templates: z
          .record(
            z.string().regex(CODENAME_PATTERN, 'template name must be alphanumeric with dashes/underscores'),
            spawnTemplateSchema,
          )
          .default(DEFAULT_SPAWN_TEMPLATES),
        /** Bound remote clone and optional ref checkout operations. */
        templateCloneTimeoutSeconds: z.number().positive().default(120),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type RuntimeName = z.infer<typeof runtimeSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type SpawnTemplate = z.infer<typeof spawnTemplateSchema>;
export type ConfiguredIntegration = z.infer<typeof configuredIntegrationSchema>;

/** Raw parse output — instance-scoped fields may be absent (loader derives them per fleet dir). */
export type SupervisorConfigInput = z.infer<typeof supervisorConfigSchema>;

/** Fully-resolved config: the loader fills port/windowName/sessionName/backend from per-fleet derivation. */
export type SupervisorConfig = Omit<SupervisorConfigInput, 'mcp' | 'terminal' | 'shepherd'> & {
  mcp: SupervisorConfigInput['mcp'] & { port: number };
  terminal: Omit<SupervisorConfigInput['terminal'], 'backend' | 'windowName' | 'tmux'> & {
    backend: 'iterm' | 'tmux';
    windowName: string;
    tmux: SupervisorConfigInput['terminal']['tmux'] & { sessionName: string };
  };
  shepherd: Omit<SupervisorConfigInput['shepherd'], 'configPath'> & { configPath: string };
};

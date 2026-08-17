import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { SHEPHERD_EVENT_TYPES } from './types.js';

const strictObject = <T extends z.ZodRawShape>(shape: T): z.ZodObject<T, 'strict'> => z.object(shape).strict();
const automationMode = z.enum(['off', 'notify', 'execute']);

const botSchema = strictObject({
  username: z.string().min(1),
  actionablePatterns: z.array(z.string().min(1)).default([]),
  positivePatterns: z.array(z.string().min(1)).default([]),
  inboxGate: z.boolean().default(false),
  maxFeedbackAttempts: z.number().int().min(0).default(2),
});

const configSchema = strictObject({
  version: z.literal(2),
  profile: strictObject({ githubUser: z.string().min(1) }),
  polling: strictObject({
    intervalSeconds: z.number().int().min(10).default(180),
    bootstrap: z.enum(['notify-current', 'baseline-only']).default('notify-current'),
  }).default({}),
  github: strictObject({
    defaultRepo: z.string().min(1).nullable().default(null),
    includeOwners: z.array(z.string().min(1)).default([]),
    includeRepos: z.array(z.string().min(1)).default([]),
    excludeOwners: z.array(z.string().min(1)).default([]),
    excludeRepos: z.array(z.string().min(1)).default([]),
    mode: z.enum(['direct', 'merge-queue']).default('direct'),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  }).default({}),
  checks: strictObject({
    required: z.array(z.string().min(1)).default([]),
    ignored: z.array(z.string().min(1)).default([]),
  }).default({}),
  reviews: strictObject({
    ignoredActors: z.array(z.string().min(1)).default([]),
    ignoredCommentPatterns: z.array(z.string().min(1)).default([]),
    requiredApprovals: z.number().int().min(0).default(1),
    bots: z.array(botSchema).default([]),
  }).default({}),
  features: strictObject({
    authoredPRs: strictObject({ enabled: z.boolean().default(true) }).default({}),
    trackedPRs: strictObject({
      enabled: z.boolean().default(false),
      releaseGate: z.enum(['none', 'exact-head-attestation']).default('none'),
    }).default({}),
    reviewInbox: strictObject({
      enabled: z.boolean().default(false),
      ignoreDrafts: z.boolean().default(true),
      ignoredRepos: z.array(z.string().min(1)).default([]),
      maxAgeDays: z.number().int().positive().default(5),
    }).default({}),
    reviewFollowUp: strictObject({ enabled: z.boolean().default(false) }).default({}),
    reviewerNudge: strictObject({
      enabled: z.boolean().default(false),
      escalateAfterHours: z.number().positive().default(24),
      businessDaysOnly: z.boolean().default(true),
      timezone: z.string().min(1).default('UTC'),
      maxEscalations: z.number().int().min(0).nullable().default(1),
    }).default({}),
    staleThresholdHours: z.number().nonnegative().default(4),
  }).default({}),
  automation: strictObject({
    autoMerge: automationMode.default('notify'),
    branchUpdate: automationMode.default('notify'),
    reviewerComment: automationMode.default('notify'),
  }).default({}),
  delivery: z
    .discriminatedUnion('type', [
      strictObject({ type: z.literal('stdout') }),
      strictObject({
        type: z.literal('conductor'),
        endpoint: z
          .string()
          .url()
          .refine((value) => {
            const host = new URL(value).hostname;
            return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
          }, 'initial Conductor delivery must use a localhost endpoint'),
        coordinatorSession: z.string().min(1).max(54),
      }),
    ])
    .default({ type: 'stdout' }),
  guidance: z.record(z.enum(SHEPHERD_EVENT_TYPES), z.string().min(1)).default({}),
  databasePath: z.string().min(1).default('./data/pr-shepherd-v2.db'),
});

export type ShepherdConfig = z.infer<typeof configSchema>;

export interface ConfigOverrides {
  githubUser?: string;
  coordinatorSession?: string;
  conductorEndpoint?: string;
  databasePath?: string;
}

function environmentOverrides(env: NodeJS.ProcessEnv): ConfigOverrides {
  return {
    ...(env.PR_SHEPHERD_GITHUB_USER !== undefined ? { githubUser: env.PR_SHEPHERD_GITHUB_USER } : {}),
    ...(env.PR_SHEPHERD_COORDINATOR_SESSION !== undefined
      ? { coordinatorSession: env.PR_SHEPHERD_COORDINATOR_SESSION }
      : {}),
    ...(env.PR_SHEPHERD_CONDUCTOR_ENDPOINT !== undefined
      ? { conductorEndpoint: env.PR_SHEPHERD_CONDUCTOR_ENDPOINT }
      : {}),
    ...(env.PR_SHEPHERD_DATABASE_PATH !== undefined ? { databasePath: env.PR_SHEPHERD_DATABASE_PATH } : {}),
  };
}

function applyOverrides(input: unknown, overrides: ConfigOverrides): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const result = structuredClone(input) as Record<string, unknown>;
  if (overrides.githubUser !== undefined) {
    result.profile = { ...(result.profile ?? {}), githubUser: overrides.githubUser };
  }
  if (overrides.databasePath !== undefined) result.databasePath = overrides.databasePath;
  if (overrides.coordinatorSession !== undefined || overrides.conductorEndpoint !== undefined) {
    const delivery = result.delivery;
    if (
      typeof delivery === 'object' &&
      delivery !== null &&
      !Array.isArray(delivery) &&
      (delivery as Record<string, unknown>).type === 'conductor'
    ) {
      result.delivery = {
        ...delivery,
        ...(overrides.coordinatorSession !== undefined ? { coordinatorSession: overrides.coordinatorSession } : {}),
        ...(overrides.conductorEndpoint !== undefined ? { endpoint: overrides.conductorEndpoint } : {}),
      };
    }
  }
  return result;
}

export function parseShepherdConfig(input: unknown, overrides: ConfigOverrides = {}): ShepherdConfig {
  const parsed = configSchema.parse(applyOverrides(input, overrides));
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.features.reviewerNudge.timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${parsed.features.reviewerNudge.timezone}`);
  }
  return parsed;
}

export function loadShepherdConfig(
  configPath: string,
  cliOverrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ShepherdConfig {
  const resolvedPath = resolve(configPath);
  let text: string;
  try {
    text = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `PR Shepherd profile is missing at ${resolvedPath}. Run pr-shepherd init -C <fleetDir> or conductor start to recreate it.`,
      );
    }
    throw error;
  }
  const parsed = parseShepherdConfig(yaml.load(text), { ...environmentOverrides(env), ...cliOverrides });
  parsed.databasePath = resolve(dirname(resolvedPath), parsed.databasePath);
  return parsed;
}

export function assertShepherdProfileReady(configPath: string): void {
  const resolvedPath = resolve(configPath);
  let text: string;
  try {
    text = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `PR Shepherd profile is missing at ${resolvedPath}. Run pr-shepherd init -C <fleetDir> or conductor start to recreate it.`,
      );
    }
    throw error;
  }
  const markerPresent = text.includes('agent-conductor-pr-shepherd-scaffold: identity-required');
  const parsed = parseShepherdConfig(yaml.load(text));
  if (markerPresent || parsed.profile.githubUser === 'CHANGE_ME') {
    throw new Error(
      `Set profile.githubUser in ${resolvedPath} and remove its identity-required marker before polling or starting PR Shepherd.`,
    );
  }
}

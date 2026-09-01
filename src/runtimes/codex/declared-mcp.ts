import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { z, type ZodError } from 'zod';
import { DECLARED_MCP_ID_PATTERN, type SessionConfig, type SupervisorConfig } from '../../config/schema.js';
import { shellQuote, tomlString } from './config-gen.js';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const AUTH_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9._~-]* $/;
const SAFE_LITERAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEADER_LITERAL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ,._:/-]*[A-Za-z0-9._:/-])?$/;
const SENSITIVE_NAME_PATTERN = /(?:auth|bearer|cookie|credential|key|pass|secret|token)/iu;
const INLINE_CREDENTIAL_PATTERN = /(?:authorization|bearer|password|passwd|secret|token|api[-_]?key)\s*(?:=|:)/iu;
const CREDENTIAL_ARGUMENT_PATTERN =
  /^--?(?:authorization|bearer|password|passwd|secret|token|api[-_]?key)(?:$|[=_-])/iu;
const UNSUPPORTED_INTERPOLATION_PATTERN = /\$\{|\$\(|\{\{|\}\}|%[A-Za-z_][A-Za-z0-9_]*%/u;
const RESERVED_SERVER_IDS = new Set(['conductor']);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SERVERS = 128;
const MAX_PROFILES = 32;
const MAX_ENTRIES = 128;

const idSchema = z.string().regex(DECLARED_MCP_ID_PATTERN);
const envNameSchema = z.string().regex(ENV_NAME_PATTERN);
const uniqueNames = (label: string) =>
  z
    .array(z.string().min(1).max(256))
    .max(MAX_ENTRIES)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `duplicate ${label}` });
        }
        seen.add(value);
      }
    });

function rejectOversizedRecord(value: Readonly<Record<string, unknown>>, context: z.RefinementCtx, path: string): void {
  if (Object.keys(value).length > MAX_ENTRIES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `may contain at most ${MAX_ENTRIES} entries`,
    });
  }
}

const envHeaderValueSchema = z.union([
  envNameSchema,
  z
    .object({
      env: envNameSchema,
      prefix: z
        .string()
        .max(32)
        .regex(AUTH_PREFIX_PATTERN, 'must be a bounded authentication-scheme prefix ending in one space'),
    })
    .strict(),
]);

const commonServerFields = {
  id: idSchema,
  required: z.boolean(),
  tools: uniqueNames('tool name').optional(),
  startupTimeoutSec: z.number().int().positive().optional(),
  toolTimeoutSec: z.number().int().positive().optional(),
};

const stdioServerSchema = z
  .object({
    ...commonServerFields,
    transport: z.literal('stdio'),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(MAX_ENTRIES).default([]),
    cwd: z.string().trim().min(1).max(1024).optional(),
    envVars: uniqueNames('environment-variable name').pipe(z.array(envNameSchema)).default([]),
    /** Target environment name -> source environment name; values remain process-only. */
    envMap: z.record(envNameSchema, envNameSchema).default({}),
    /** Bounded non-secret selectors only; credential-like names and values are rejected below. */
    literalEnv: z.record(envNameSchema, z.string()).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    rejectOversizedRecord(value.envMap, context, 'envMap');
    rejectOversizedRecord(value.literalEnv, context, 'literalEnv');
    for (const [index, arg] of value.args.entries()) {
      if (UNSUPPORTED_INTERPOLATION_PATTERN.test(arg)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['args', index], message: 'unsupported interpolation' });
      }
      if (INLINE_CREDENTIAL_PATTERN.test(arg) || CREDENTIAL_ARGUMENT_PATTERN.test(arg)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['args', index],
          message: 'inline credential material is not allowed',
        });
      }
    }
    for (const field of ['command', 'cwd'] as const) {
      const candidate = value[field];
      if (candidate !== undefined && UNSUPPORTED_INTERPOLATION_PATTERN.test(candidate)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'unsupported interpolation' });
      }
    }
    for (const [name, literal] of Object.entries(value.literalEnv)) {
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['literalEnv', name],
          message: 'credential-like environment names must use a name-only reference',
        });
      }
      if (!SAFE_LITERAL_PATTERN.test(literal) || INLINE_CREDENTIAL_PATTERN.test(literal)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['literalEnv', name],
          message: 'must be a bounded non-secret literal without interpolation',
        });
      }
    }
  });

const httpServerSchema = z
  .object({
    ...commonServerFields,
    transport: z.literal('streamable-http'),
    url: z.string().max(4096).url(),
    auth: z.literal('oauth').optional(),
    bearerTokenEnvVar: envNameSchema.optional(),
    envHttpHeaders: z.record(z.string().max(128).regex(HTTP_HEADER_PATTERN), envHeaderValueSchema).default({}),
    /** Bounded non-secret literal headers only; credential-like names and values are rejected below. */
    httpHeaders: z.record(z.string().max(128).regex(HTTP_HEADER_PATTERN), z.string().max(256)).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    rejectOversizedRecord(value.envHttpHeaders, context, 'envHttpHeaders');
    rejectOversizedRecord(value.httpHeaders, context, 'httpHeaders');
    const seenHeaderNames = new Set<string>();
    for (const name of Object.keys(value.envHttpHeaders)) {
      if (seenHeaderNames.has(name.toLowerCase())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['envHttpHeaders', name],
          message: 'case-colliding header name',
        });
      }
      seenHeaderNames.add(name.toLowerCase());
    }
    for (const [name, literal] of Object.entries(value.httpHeaders)) {
      if (seenHeaderNames.has(name.toLowerCase())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['httpHeaders', name],
          message: 'collides with another declared header name',
        });
      }
      seenHeaderNames.add(name.toLowerCase());
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['httpHeaders', name],
          message: 'credential-like header names must use a name-only environment reference',
        });
      }
      if (
        !HEADER_LITERAL_PATTERN.test(literal) ||
        INLINE_CREDENTIAL_PATTERN.test(literal) ||
        UNSUPPORTED_INTERPOLATION_PATTERN.test(literal)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['httpHeaders', name],
          message: 'must be a bounded non-secret literal without interpolation',
        });
      }
    }
    let parsed: URL | undefined;
    try {
      parsed = new URL(value.url);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'must use http or https' });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'inline URL credentials are not allowed',
      });
    }
    if (UNSUPPORTED_INTERPOLATION_PATTERN.test(value.url)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'unsupported interpolation' });
    }
    for (const name of parsed.searchParams.keys()) {
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'credential-like query parameters must use a name-only authentication reference',
        });
      }
    }
    const hasAuthorizationHeader = Object.keys(value.envHttpHeaders).some(
      (header) => header.toLowerCase() === 'authorization',
    );
    if (value.auth !== undefined && (value.bearerTokenEnvVar !== undefined || hasAuthorizationHeader)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth'],
        message: 'oauth cannot be combined with bearer or Authorization-header references',
      });
    }
    if (value.bearerTokenEnvVar !== undefined && hasAuthorizationHeader) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bearerTokenEnvVar'],
        message: 'cannot be combined with an Authorization header reference',
      });
    }
  });

export const declaredMcpManifestSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    servers: z.array(z.union([stdioServerSchema, httpServerSchema])).max(MAX_SERVERS),
    profiles: z.record(
      idSchema,
      z.object({ servers: uniqueNames('server reference').pipe(z.array(idSchema)) }).strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const profileCount = Object.keys(value.profiles).length;
    if (profileCount === 0 || profileCount > MAX_PROFILES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profiles'],
        message: `must contain between 1 and ${MAX_PROFILES} profiles`,
      });
    }
    const ids = new Set<string>();
    for (const [index, server] of value.servers.entries()) {
      if (RESERVED_SERVER_IDS.has(server.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servers', index, 'id'],
          message: 'is reserved by Agent Conductor',
        });
      }
      if (ids.has(server.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servers', index, 'id'],
          message: 'duplicate server ID',
        });
      }
      ids.add(server.id);
    }
    for (const [profile, selected] of Object.entries(value.profiles)) {
      for (const [index, serverId] of selected.servers.entries()) {
        if (!ids.has(serverId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profiles', profile, 'servers', index],
            message: 'references an unknown server ID',
          });
        }
      }
    }
  });

export type DeclaredMcpManifest = z.infer<typeof declaredMcpManifestSchema>;
export type DeclaredMcpServer = DeclaredMcpManifest['servers'][number];

export interface DeclaredMcpReadinessServer {
  id: string;
  declarationId: string;
  transport: DeclaredMcpServer['transport'];
  required: boolean;
  declared: true;
  configured: boolean;
  enabled: boolean;
  authenticated: 'not-attempted' | 'not-asserted';
  connected: 'not-attempted' | 'not-asserted';
  listed: 'not-attempted' | 'not-asserted';
  invoked: 'not-attempted' | 'not-asserted';
  declaredToolCount: number | null;
  schemaStatus: 'pending-runtime-initialization' | 'degraded-missing-prerequisites' | 'blocked-missing-prerequisites';
  missingCredentialNames: string[];
  missingPrerequisites: string[];
}

export interface DeclaredMcpReadiness {
  version: 1;
  toolProfile: string;
  schemaCacheDisposition: 'fresh-process-on-launch';
  callableParity: 'not-asserted';
  /** Fleet-approved shared connector IDs that survive isolation for this profile; names only. */
  preservedSharedServerIds: string[];
  servers: DeclaredMcpReadinessServer[];
}

export interface GeneratedDeclaredMcpFile {
  path: string;
  content: string;
  mode: number;
}

export interface PreparedDeclaredMcp {
  configToml: string;
  readiness: DeclaredMcpReadiness;
  generatedFiles: GeneratedDeclaredMcpFile[];
  launchEnvironmentWrapper?: string;
  disabledProjectServerIds: string[];
  /** Fleet-approved shared connector IDs exempt from stripping and launch-disable overrides. */
  preservedSharedServerIds: string[];
  fatalError?: string;
}

interface DerivedEnvironmentValue {
  target: string;
  source: string;
  prefix: string;
}

interface SelectedServer {
  declarationId: string;
  originBase: string;
  server: DeclaredMcpServer;
}

type DeclaredMcpSettings = NonNullable<SupervisorConfig['runtimes']['codex']['declaredMcp']>;

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Parse an already-decoded declaration without ever echoing rejected field values. */
export function parseDeclaredMcpManifest(raw: unknown, file = 'declared MCP manifest'): DeclaredMcpManifest {
  const parsed = declaredMcpManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid declared MCP manifest at ${file}: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

async function loadManifest(file: string): Promise<DeclaredMcpManifest> {
  let raw: unknown;
  try {
    const encoded = await readFile(file);
    if (encoded.byteLength > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds size limit');
    raw = yaml.load(encoded.toString('utf8'));
  } catch (error) {
    const line = (error as { mark?: { line?: unknown } }).mark?.line;
    const location = typeof line === 'number' ? ` near line ${String(line + 1)}` : '';
    throw new Error(`Invalid declared MCP YAML at ${file}: parse failed${location}`);
  }
  return parseDeclaredMcpManifest(raw, file);
}

function isContained(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

class DeclaredMcpPathError extends Error {
  constructor(
    message: string,
    readonly kind: 'escape' | 'missing',
  ) {
    super(message);
  }
}

async function resolveContainedPath(base: string, requested: string, label: string): Promise<string> {
  if (isAbsolute(requested)) {
    throw new DeclaredMcpPathError(`${label} must be relative to its declared scope`, 'escape');
  }
  const lexicalBase = resolve(base);
  const lexicalTarget = resolve(lexicalBase, requested);
  if (!isContained(lexicalBase, lexicalTarget)) {
    throw new DeclaredMcpPathError(`${label} escapes its declared scope`, 'escape');
  }
  let canonicalBase: string;
  let canonicalTarget: string;
  try {
    [canonicalBase, canonicalTarget] = await Promise.all([realpath(lexicalBase), realpath(lexicalTarget)]);
  } catch {
    throw new DeclaredMcpPathError(`${label} is missing or unreadable`, 'missing');
  }
  if (!isContained(canonicalBase, canonicalTarget)) {
    throw new DeclaredMcpPathError(`${label} escapes its declared scope through a symlink`, 'escape');
  }
  return canonicalTarget;
}

function envIsPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

async function resolveExecutable(
  command: string,
  cwd: string,
  originBase: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) {
    if (isAbsolute(command)) {
      throw new DeclaredMcpPathError(`${label} must be bare or relative to its declared scope`, 'escape');
    }
    const target = resolve(cwd, command);
    const lexicalBase = resolve(originBase);
    if (!isContained(lexicalBase, target)) {
      throw new DeclaredMcpPathError(`${label} escapes its declared scope`, 'escape');
    }
    let canonicalBase: string;
    let canonicalTarget: string;
    try {
      [canonicalBase, canonicalTarget] = await Promise.all([realpath(lexicalBase), realpath(target)]);
    } catch {
      return null;
    }
    if (!isContained(canonicalBase, canonicalTarget)) {
      throw new DeclaredMcpPathError(`${label} escapes its declared scope through a symlink`, 'escape');
    }
    try {
      await access(canonicalTarget, constants.X_OK);
      return canonicalTarget;
    } catch {
      return null;
    }
  }
  for (const entry of (env.PATH ?? '').split(':')) {
    if (entry.length === 0) continue;
    const target = isAbsolute(entry) ? resolve(entry, command) : resolve(cwd, entry, command);
    try {
      const canonicalTarget = await realpath(target);
      await access(canonicalTarget, constants.X_OK);
      return canonicalTarget;
    } catch {
      // Keep searching the bounded PATH list without invoking a shell.
    }
  }
  return null;
}

function requiredEnvironmentNames(server: DeclaredMcpServer): string[] {
  if (server.transport === 'stdio') {
    return [...new Set([...server.envVars, ...Object.values(server.envMap)])].sort();
  }
  const names = Object.values(server.envHttpHeaders).map((value) => (typeof value === 'string' ? value : value.env));
  if (server.bearerTokenEnvVar !== undefined) names.push(server.bearerTokenEnvVar);
  return [...new Set(names)].sort();
}

function renderInlineTable(values: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

function renderStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function wrapperExport(target: string, source: string, prefix = ''): string {
  return `export ${target}=${shellQuote(prefix)}"\${${source}-}"`;
}

function renderServerConfig(
  selected: SelectedServer,
  enabled: boolean,
  resolvedCommand: string | undefined,
  resolvedCwd: string | undefined,
  configDir: string,
  serverIndex: number,
  generatedFiles: GeneratedDeclaredMcpFile[],
  derivedEnvironment: DerivedEnvironmentValue[],
): string {
  const { server } = selected;
  const lines = [`[mcp_servers.${server.id}]`];
  if (server.transport === 'stdio') {
    let command = resolvedCommand ?? server.command;
    let args = server.args;
    if (Object.keys(server.envMap).length > 0) {
      const wrapperPath = resolve(configDir, `declared-mcp-${server.id}.sh`);
      const wrapper = [
        '#!/bin/sh',
        '# generated by agent-conductor (codex runtime); contains environment names only',
        ...Object.entries(server.envMap)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([target, source]) => wrapperExport(target, source)),
        `exec ${[command, ...server.args].map(shellQuote).join(' ')}`,
        '',
      ].join('\n');
      generatedFiles.push({ path: wrapperPath, content: wrapper, mode: 0o700 });
      command = wrapperPath;
      args = [];
    }
    lines.push(`command = ${tomlString(command)}`);
    if (args.length > 0) lines.push(`args = ${renderStringArray(args)}`);
    if (resolvedCwd !== undefined) lines.push(`cwd = ${tomlString(resolvedCwd)}`);
    const envVars = [...new Set([...server.envVars, ...Object.values(server.envMap)])].sort();
    if (envVars.length > 0) lines.push(`env_vars = ${renderStringArray(envVars)}`);
    if (Object.keys(server.literalEnv).length > 0) lines.push(`env = ${renderInlineTable(server.literalEnv)}`);
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.auth !== undefined) lines.push(`auth = ${tomlString(server.auth)}`);
    if (server.bearerTokenEnvVar !== undefined) {
      lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
    }
    if (Object.keys(server.httpHeaders).length > 0) {
      lines.push(`http_headers = ${renderInlineTable(server.httpHeaders)}`);
    }
    const headers: Record<string, string> = {};
    for (const [headerIndex, [header, value]] of Object.entries(server.envHttpHeaders)
      .sort(([left], [right]) => left.localeCompare(right))
      .entries()) {
      if (typeof value === 'string') {
        headers[header] = value;
      } else {
        const derived = `CONDUCTOR_MCP_HTTP_${String(serverIndex)}_${String(headerIndex)}`;
        headers[header] = derived;
        derivedEnvironment.push({ target: derived, source: value.env, prefix: value.prefix });
      }
    }
    if (Object.keys(headers).length > 0) lines.push(`env_http_headers = ${renderInlineTable(headers)}`);
  }
  lines.push(`required = ${server.required ? 'true' : 'false'}`);
  lines.push(`enabled = ${enabled ? 'true' : 'false'}`);
  if (server.tools !== undefined) lines.push(`enabled_tools = ${renderStringArray(server.tools)}`);
  if (server.startupTimeoutSec !== undefined) lines.push(`startup_timeout_sec = ${String(server.startupTimeoutSec)}`);
  if (server.toolTimeoutSec !== undefined) lines.push(`tool_timeout_sec = ${String(server.toolTimeoutSec)}`);
  return `${lines.join('\n')}\n`;
}

function parseTomlKeyPath(input: string): string[] | null {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    while (/\s/u.test(input[cursor] ?? '')) cursor += 1;
    if (cursor >= input.length) break;
    const quote = input[cursor];
    let value = '';
    if (quote === '"' || quote === "'") {
      cursor += 1;
      while (cursor < input.length) {
        const character = input[cursor] ?? '';
        if (character === quote) {
          cursor += 1;
          break;
        }
        if (quote === '"' && character === '\\' && cursor + 1 < input.length) {
          value += input[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        value += character;
        cursor += 1;
      }
    } else {
      const match = /^[A-Za-z0-9_-]+/u.exec(input.slice(cursor));
      if (match === null) return null;
      value = match[0];
      cursor += value.length;
    }
    values.push(value);
    while (/\s/u.test(input[cursor] ?? '')) cursor += 1;
    if (cursor >= input.length) break;
    if (input[cursor] !== '.') return null;
    cursor += 1;
  }
  return values.length > 0 ? values : null;
}

function tomlHeaderPath(line: string): string[] | null {
  const trimmed = line.trim();
  const array = trimmed.startsWith('[[');
  const open = array ? 2 : trimmed.startsWith('[') ? 1 : 0;
  const close = array ? ']]' : ']';
  if (open === 0) return null;
  const end = trimmed.indexOf(close, open);
  if (end < 0) return null;
  const trailing = trimmed.slice(end + close.length).trim();
  if (trailing.length > 0 && !trailing.startsWith('#')) return null;
  return parseTomlKeyPath(trimmed.slice(open, end));
}

/**
 * Remove MCP-server tables from a private copy of shared Codex config.
 * Explicitly preserved server IDs keep their tables untouched; their contents
 * are copied verbatim, never parsed for values.
 */
export function stripMcpServerConfig(source: string, preserveServerIds: readonly string[] = []): string {
  const preserve = new Set(preserveServerIds);
  const output: string[] = [];
  let skip = false;
  let inBareServersTable = false;
  let sawHeader = false;
  for (const line of source.split(/(?<=\n)/u)) {
    const header = tomlHeaderPath(line);
    if (header !== null) {
      sawHeader = true;
      inBareServersTable = header[0] === 'mcp_servers' && header.length === 1;
      if (inBareServersTable) {
        // Dotted keys under a bare [mcp_servers] table are filtered per line below.
        skip = true;
        if (preserve.size > 0) output.push(line);
        continue;
      }
      skip = header[0] === 'mcp_servers' && !(header[1] !== undefined && preserve.has(header[1]));
      if (!skip) output.push(line);
      continue;
    }
    if (!sawHeader && /^\s*mcp_servers(?:\s*=|\s*\.)/u.test(line)) {
      throw new Error('Shared Codex config uses unsupported root-level mcp_servers assignment syntax');
    }
    if (inBareServersTable) {
      const assignment = /^\s*([^#=]+?)\s*=/u.exec(line);
      const key = assignment === null ? null : parseTomlKeyPath(assignment[1] ?? '');
      if (key?.[0] !== undefined && preserve.has(key[0])) output.push(line);
      continue;
    }
    if (!skip) output.push(line);
  }
  return output.join('');
}

/** Discover MCP IDs in a project config so launch overrides can disable unselected project-local servers. */
export function discoverMcpServerIds(source: string): string[] {
  const ids = new Set<string>();
  let current: string[] | null = null;
  let sawHeader = false;
  for (const line of source.split('\n')) {
    const header = tomlHeaderPath(line);
    if (header !== null) {
      sawHeader = true;
      current = header;
      if (header[0] === 'mcp_servers' && header[1] !== undefined) ids.add(header[1]);
      continue;
    }
    const assignment = /^\s*([^#=]+?)\s*=/u.exec(line);
    if (assignment === null) continue;
    const key = parseTomlKeyPath(assignment[1] ?? '');
    if (key === null) continue;
    if (!sawHeader && key[0] === 'mcp_servers') {
      if (key[1] === undefined) throw new Error('Project Codex config uses unsupported inline mcp_servers syntax');
      ids.add(key[1]);
    } else if (current?.[0] === 'mcp_servers' && current.length === 1 && key[0] !== undefined) {
      ids.add(key[0]);
    }
  }
  return [...ids].sort();
}

async function selectServers(
  settings: DeclaredMcpSettings,
  session: SessionConfig,
  fleetBase: string,
): Promise<{ toolProfile: string; servers: SelectedServer[]; preservedSharedServerIds: string[] }> {
  const toolProfile = session.toolProfile ?? settings.defaultProfile;
  const composition = settings.profiles[toolProfile];
  if (composition === undefined) throw new Error(`Unknown declared MCP tool profile '${toolProfile}'`);
  const preservedSharedServerIds = [...(composition.preserveSharedServers ?? [])].sort();
  const selected: SelectedServer[] = [];
  const ids = new Set<string>();
  for (const source of composition.sources) {
    const originBase = source.scope === 'repo' ? session.repo : fleetBase;
    const file = await resolveContainedPath(
      originBase,
      source.file,
      `Declared MCP source for profile '${toolProfile}'`,
    );
    const manifest = await loadManifest(file);
    const profile = manifest.profiles[source.profile];
    if (profile === undefined) {
      throw new Error(`Declared MCP manifest '${manifest.id}' has no profile '${source.profile}'`);
    }
    const byId = new Map(manifest.servers.map((server) => [server.id, server]));
    for (const serverId of profile.servers) {
      if (ids.has(serverId)) throw new Error(`Duplicate declared MCP server ID '${serverId}' across selected sources`);
      ids.add(serverId);
      selected.push({ declarationId: manifest.id, originBase, server: byId.get(serverId)! });
    }
  }
  selected.sort((left, right) => left.server.id.localeCompare(right.server.id));
  return { toolProfile, servers: selected, preservedSharedServerIds };
}

export async function prepareDeclaredMcp(options: {
  settings: DeclaredMcpSettings;
  session: SessionConfig;
  fleetBase: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  environmentFile?: string;
  projectCodexConfig?: string | null;
}): Promise<PreparedDeclaredMcp> {
  const env = options.env ?? process.env;
  const { toolProfile, servers, preservedSharedServerIds } = await selectServers(
    options.settings,
    options.session,
    options.fleetBase,
  );
  const selectedIds = new Set(servers.map(({ server }) => server.id));
  const reservedPreserved = preservedSharedServerIds.filter((id) => RESERVED_SERVER_IDS.has(id));
  if (reservedPreserved.length > 0) {
    throw new Error(`Preserved shared MCP server IDs are reserved by Agent Conductor: ${reservedPreserved.join(', ')}`);
  }
  const preservedConflicts = preservedSharedServerIds.filter((id) => selectedIds.has(id));
  if (preservedConflicts.length > 0) {
    throw new Error(
      `Preserved shared MCP server IDs conflict with declared MCP server IDs: ${preservedConflicts.join(', ')}`,
    );
  }
  const preservedSet = new Set(preservedSharedServerIds);
  const projectServerIds = discoverMcpServerIds(options.projectCodexConfig ?? '');
  const conflicts = projectServerIds.filter((id) => selectedIds.has(id));
  if (conflicts.length > 0) {
    throw new Error(`Project Codex config conflicts with declared MCP server IDs: ${conflicts.join(', ')}`);
  }

  const readinessServers: DeclaredMcpReadinessServer[] = [];
  const generatedFiles: GeneratedDeclaredMcpFile[] = [];
  const derivedEnvironment: DerivedEnvironmentValue[] = [];
  const configs: string[] = [];
  const fatal: string[] = [];

  for (const [serverIndex, selected] of servers.entries()) {
    const { server, originBase } = selected;
    const missingCredentialNames = requiredEnvironmentNames(server).filter((name) => !envIsPresent(env, name));
    const missingPrerequisites: string[] = [];
    let resolvedCommand: string | undefined;
    let resolvedCwd: string | undefined;
    if (server.transport === 'stdio') {
      let cwd = originBase;
      if (server.cwd !== undefined) {
        try {
          cwd = await resolveContainedPath(originBase, server.cwd, `cwd for declared MCP server '${server.id}'`);
          if ((await stat(cwd)).isDirectory()) resolvedCwd = cwd;
          else missingPrerequisites.push('cwd');
        } catch (error) {
          if (error instanceof DeclaredMcpPathError && error.kind === 'escape') throw error;
          missingPrerequisites.push('cwd');
        }
      }
      resolvedCommand =
        (await resolveExecutable(
          server.command,
          cwd,
          originBase,
          env,
          `command for declared MCP server '${server.id}'`,
        )) ?? undefined;
      if (resolvedCommand === undefined) missingPrerequisites.push('command');
    }
    const missing = missingCredentialNames.length > 0 || missingPrerequisites.length > 0;
    const enabled = !missing;
    const configured = !missing;
    const runtimeEvidence = configured ? ('not-asserted' as const) : ('not-attempted' as const);
    const schemaStatus = missing
      ? server.required
        ? ('blocked-missing-prerequisites' as const)
        : ('degraded-missing-prerequisites' as const)
      : ('pending-runtime-initialization' as const);
    readinessServers.push({
      id: server.id,
      declarationId: selected.declarationId,
      transport: server.transport,
      required: server.required,
      declared: true,
      configured,
      enabled,
      authenticated: runtimeEvidence,
      connected: runtimeEvidence,
      listed: runtimeEvidence,
      invoked: runtimeEvidence,
      declaredToolCount: server.tools?.length ?? null,
      schemaStatus,
      missingCredentialNames,
      missingPrerequisites: [...new Set(missingPrerequisites)].sort(),
    });
    if (missing && server.required) fatal.push(server.id);
    configs.push(
      renderServerConfig(
        selected,
        enabled,
        resolvedCommand,
        resolvedCwd,
        options.configDir,
        serverIndex,
        generatedFiles,
        derivedEnvironment,
      ),
    );
  }

  let launchEnvironmentWrapper: string | undefined;
  const allowlistedEnvironmentNames = [
    ...new Set(servers.flatMap(({ server }) => requiredEnvironmentNames(server))),
  ].sort();
  if (allowlistedEnvironmentNames.length > 0 || derivedEnvironment.length > 0) {
    launchEnvironmentWrapper = resolve(options.configDir, 'declared-mcp-env.mjs');
    generatedFiles.push({
      path: launchEnvironmentWrapper,
      content: `#!/usr/bin/env node
// generated by agent-conductor (codex runtime); contains environment names only
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';

const allowlisted = ${JSON.stringify(allowlistedEnvironmentNames)};
const environmentFile = ${JSON.stringify(options.environmentFile ?? null)};
if (environmentFile !== null && existsSync(environmentFile)) {
  let local;
  try {
    local = parseEnv(readFileSync(environmentFile, 'utf8'));
  } catch {
    process.stderr.write('Agent Conductor could not read the fleet environment file for declared MCP launch.\\n');
    process.exit(1);
  }
  for (const name of allowlisted) {
    const value = local[name];
    if (typeof value === 'string') process.env[name] = value;
  }
}
for (const derived of ${JSON.stringify(derivedEnvironment)}) {
  const value = process.env[derived.source];
  if (typeof value === 'string') process.env[derived.target] = derived.prefix + value;
}
const [command, ...args] = process.argv.slice(2);
if (command === undefined) process.exit(1);
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
child.once('error', () => process.exit(1));
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
      mode: 0o700,
    });
  }

  const readiness: DeclaredMcpReadiness = {
    version: 1,
    toolProfile,
    schemaCacheDisposition: 'fresh-process-on-launch',
    callableParity: 'not-asserted',
    preservedSharedServerIds,
    servers: readinessServers,
  };
  return {
    configToml:
      configs.length === 0
        ? ''
        : `\n# generated by agent-conductor (codex runtime): declared MCP profile ${toolProfile}\n${configs.join('\n')}`,
    readiness,
    generatedFiles,
    launchEnvironmentWrapper,
    disabledProjectServerIds: projectServerIds.filter((id) => !preservedSet.has(id)),
    preservedSharedServerIds,
    ...(fatal.length === 0
      ? {}
      : {
          fatalError: `Required declared MCP servers are not ready: ${fatal.sort().join(', ')} (see name-only readiness diagnostics)`,
        }),
  };
}

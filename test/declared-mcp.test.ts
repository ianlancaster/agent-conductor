import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionConfig, SupervisorConfig } from '../src/config/schema.js';
import {
  discoverMcpServerIds,
  parseDeclaredMcpManifest,
  prepareDeclaredMcp,
  stripMcpServerConfig,
} from '../src/runtimes/codex/declared-mcp.js';

type Settings = NonNullable<SupervisorConfig['runtimes']['codex']['declaredMcp']>;

let fleetDir: string;
let repoDir: string;
let configDir: string;

beforeEach(async () => {
  fleetDir = await mkdtemp(path.join(tmpdir(), 'conductor-declared-mcp-'));
  repoDir = path.join(fleetDir, 'repo');
  configDir = path.join(fleetDir, 'session-config');
  await mkdir(path.join(repoDir, '.conductor'), { recursive: true });
  await mkdir(path.join(fleetDir, '.conductor', 'config'), { recursive: true });
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(fleetDir, { recursive: true, force: true });
});

function session(toolProfile?: string): SessionConfig {
  return {
    codename: 'worker',
    repo: repoDir,
    runtime: 'codex',
    additionalDirs: [],
    schedules: [],
    ...(toolProfile === undefined ? {} : { toolProfile }),
  };
}

async function writeManifest(file: string, manifest: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, yaml.dump(manifest, { noRefs: true, lineWidth: 120 }));
}

const projectManifest = {
  version: 1,
  id: 'example-project',
  servers: [
    {
      id: 'project-api',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      auth: 'oauth',
      required: true,
      tools: ['read_record'],
    },
    {
      id: 'local-mapped',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      required: false,
      envMap: { SERVICE_TOKEN: 'PROJECT_SERVICE_TOKEN' },
      literalEnv: { GOOGLE_CLOUD_PROJECT: 'safe-project' },
      tools: ['read_local'],
    },
    {
      id: 'observability',
      transport: 'streamable-http',
      url: 'https://observability.example.test/mcp',
      required: false,
      envHttpHeaders: {
        'Authorization': { env: 'OBSERVABILITY_AUTH', prefix: 'Basic ' },
        'X-Workspace': 'OBSERVABILITY_WORKSPACE',
      },
    },
    {
      id: 'deferred-api',
      transport: 'streamable-http',
      url: 'https://deferred.example.test/mcp',
      required: false,
      tools: ['read_deferred'],
    },
  ],
  profiles: { worker: { servers: ['project-api', 'local-mapped', 'observability'] } },
} as const;

const overlayManifest = {
  version: 1,
  id: 'engineering-manager-tools',
  servers: [
    {
      id: 'slack',
      transport: 'streamable-http',
      url: 'https://slack.example.test/mcp',
      bearerTokenEnvVar: 'SLACK_MCP_TOKEN',
      required: false,
      tools: ['search_messages'],
    },
  ],
  profiles: { 'engineering-manager': { servers: ['slack'] } },
} as const;

function settings(): Settings {
  return {
    defaultProfile: 'worker',
    profiles: {
      'worker': {
        sources: [{ scope: 'repo', file: '.conductor/mcp.yaml', profile: 'worker' }],
      },
      'engineering-manager': {
        sources: [
          { scope: 'repo', file: '.conductor/mcp.yaml', profile: 'worker' },
          {
            scope: 'fleet',
            file: '.conductor/config/mcp-engineering-manager.yaml',
            profile: 'engineering-manager',
          },
        ],
      },
    },
  };
}

describe('declared MCP manifest validation', () => {
  it('rejects unknown fields, duplicate IDs/references, reserved IDs, and inline credential material', () => {
    expect(() => parseDeclaredMcpManifest({ ...projectManifest, surprise: true })).toThrow('Unrecognized key');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [projectManifest.servers[0], { ...projectManifest.servers[0] }],
      }),
    ).toThrow('duplicate server ID');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        profiles: { worker: { servers: ['project-api', 'project-api'] } },
      }),
    ).toThrow('duplicate server reference');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [{ ...projectManifest.servers[0], id: 'conductor' }],
        profiles: { worker: { servers: ['conductor'] } },
      }),
    ).toThrow('reserved by Agent Conductor');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [
          {
            id: 'bad',
            transport: 'stdio',
            command: 'node',
            args: ['--token=inline-value'],
            required: false,
          },
        ],
        profiles: { worker: { servers: ['bad'] } },
      }),
    ).toThrow('inline credential material');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [
          {
            id: 'bad',
            transport: 'stdio',
            command: 'node',
            args: ['--api-key', 'inline-value'],
            required: false,
          },
        ],
        profiles: { worker: { servers: ['bad'] } },
      }),
    ).toThrow('inline credential material');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [
          {
            id: 'bad',
            transport: 'streamable-http',
            url: 'https://user:password@example.test/mcp',
            required: false,
          },
        ],
        profiles: { worker: { servers: ['bad'] } },
      }),
    ).toThrow('inline URL credentials');
    expect(() =>
      parseDeclaredMcpManifest({
        ...projectManifest,
        servers: [
          {
            id: 'bad',
            transport: 'stdio',
            command: 'node',
            required: false,
            literalEnv: { API_TOKEN: 'inline-value' },
          },
        ],
        profiles: { worker: { servers: ['bad'] } },
      }),
    ).toThrow('credential-like environment names');
  });

  it('accepts truthful OAuth, name-only mappings, safe literals, and bounded header prefixes', () => {
    expect(parseDeclaredMcpManifest(projectManifest).profiles.worker?.servers).toEqual([
      'project-api',
      'local-mapped',
      'observability',
    ]);
  });
});

describe('declared MCP preparation', () => {
  it('translates HTTP and stdio servers deterministically without serializing credential values', async () => {
    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), projectManifest);
    await writeManifest(path.join(fleetDir, '.conductor', 'config', 'mcp-engineering-manager.yaml'), overlayManifest);
    const environment = {
      PATH: process.env.PATH,
      PROJECT_SERVICE_TOKEN: 'credential-value-one',
      OBSERVABILITY_AUTH: 'credential-value-two',
      OBSERVABILITY_WORKSPACE: 'credential-value-three',
      SLACK_MCP_TOKEN: 'credential-value-four',
    };
    const first = await prepareDeclaredMcp({
      settings: settings(),
      session: session('engineering-manager'),
      fleetBase: fleetDir,
      configDir,
      env: environment,
      projectCodexConfig: '[mcp_servers.project_only]\nurl = "https://example.test/mcp"\n',
    });
    const second = await prepareDeclaredMcp({
      settings: settings(),
      session: session('engineering-manager'),
      fleetBase: fleetDir,
      configDir,
      env: environment,
      projectCodexConfig: '[mcp_servers.project_only]\nurl = "https://example.test/mcp"\n',
    });

    expect(second.configToml).toBe(first.configToml);
    expect(second.readiness).toEqual(first.readiness);
    expect(first.configToml).toContain('[mcp_servers.project-api]');
    expect(first.configToml).toContain('auth = "oauth"');
    expect(first.configToml).toContain('enabled_tools = ["read_record"]');
    expect(first.configToml).toContain('[mcp_servers.local-mapped]');
    expect(first.configToml).toContain('env_vars = ["PROJECT_SERVICE_TOKEN"]');
    expect(first.configToml).toContain('env = { "GOOGLE_CLOUD_PROJECT" = "safe-project" }');
    expect(first.configToml).toContain('[mcp_servers.slack]');
    expect(first.configToml).toContain('bearer_token_env_var = "SLACK_MCP_TOKEN"');
    expect(first.configToml).toContain('env_http_headers = { "Authorization" = "CONDUCTOR_MCP_HTTP_');
    expect(first.disabledProjectServerIds).toEqual(['project_only']);
    expect(first.readiness).toMatchObject({
      toolProfile: 'engineering-manager',
      schemaCacheDisposition: 'fresh-process-on-launch',
      callableParity: 'not-asserted',
    });
    expect(first.readiness.servers.find((server) => server.id === 'project-api')).toMatchObject({
      declaredToolCount: 1,
      schemaStatus: 'pending-runtime-initialization',
    });

    const generated = first.generatedFiles.map((file) => file.content).join('\n');
    for (const value of Object.values(environment)) {
      if (value !== undefined && value !== process.env.PATH)
        expect(`${first.configToml}\n${generated}`).not.toContain(value);
    }
    expect(generated).toContain('SERVICE_TOKEN');
    expect(generated).toContain('PROJECT_SERVICE_TOKEN');
    expect(generated).toContain('OBSERVABILITY_AUTH');
    expect(generated).toContain('Basic ');
  });

  it('keeps Slack out of the ordinary worker and adds it only through the explicit fleet composition', async () => {
    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), projectManifest);
    await writeManifest(path.join(fleetDir, '.conductor', 'config', 'mcp-engineering-manager.yaml'), overlayManifest);
    const env = {
      PATH: process.env.PATH,
      PROJECT_SERVICE_TOKEN: 'present',
      OBSERVABILITY_AUTH: 'present',
      OBSERVABILITY_WORKSPACE: 'present',
      SLACK_MCP_TOKEN: 'present',
    };
    const worker = await prepareDeclaredMcp({
      settings: settings(),
      session: session(),
      fleetBase: fleetDir,
      configDir,
      env,
    });
    const manager = await prepareDeclaredMcp({
      settings: settings(),
      session: session('engineering-manager'),
      fleetBase: fleetDir,
      configDir,
      env,
    });
    expect(worker.readiness.toolProfile).toBe('worker');
    expect(worker.readiness.servers.map((server) => server.id)).not.toContain('slack');
    expect(worker.configToml).not.toContain('mcp_servers.slack');
    expect(worker.readiness.servers.map((server) => server.id)).not.toContain('deferred-api');
    expect(worker.configToml).not.toContain('mcp_servers.deferred-api');
    expect(manager.readiness.servers.map((server) => server.id)).toContain('slack');
  });

  it('fails required missing credentials/commands and leaves optional failures visible but disabled', async () => {
    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), {
      version: 1,
      id: 'readiness',
      servers: [
        {
          id: 'required-http',
          transport: 'streamable-http',
          url: 'https://example.test/mcp',
          bearerTokenEnvVar: 'REQUIRED_TOKEN',
          required: true,
        },
        {
          id: 'optional-local',
          transport: 'stdio',
          command: 'definitely-not-a-command',
          envVars: ['OPTIONAL_TOKEN'],
          required: false,
        },
      ],
      profiles: { worker: { servers: ['required-http', 'optional-local'] } },
    });
    const prepared = await prepareDeclaredMcp({
      settings: settings(),
      session: session(),
      fleetBase: fleetDir,
      configDir,
      env: { PATH: process.env.PATH },
    });
    expect(prepared.fatalError).toContain('required-http');
    expect(prepared.fatalError).not.toContain('OPTIONAL_TOKEN');
    expect(prepared.readiness.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'required-http',
          configured: false,
          enabled: false,
          missingCredentialNames: ['REQUIRED_TOKEN'],
          schemaStatus: 'blocked-missing-prerequisites',
        }),
        expect.objectContaining({
          id: 'optional-local',
          declared: true,
          configured: false,
          enabled: false,
          authenticated: 'not-attempted',
          connected: 'not-attempted',
          listed: 'not-attempted',
          invoked: 'not-attempted',
          missingCredentialNames: ['OPTIONAL_TOKEN'],
          missingPrerequisites: ['command'],
          schemaStatus: 'degraded-missing-prerequisites',
        }),
      ]),
    );
    expect(prepared.configToml).toContain('[mcp_servers.optional-local]');
    expect(prepared.configToml).toContain('enabled = false');
  });

  it('rejects lexical and symlink declaration path escapes', async () => {
    const outside = path.join(fleetDir, 'outside.yaml');
    await writeManifest(outside, projectManifest);
    const escaping: Settings = {
      defaultProfile: 'worker',
      profiles: { worker: { sources: [{ scope: 'repo', file: '../outside.yaml', profile: 'worker' }] } },
    };
    await expect(
      prepareDeclaredMcp({ settings: escaping, session: session(), fleetBase: fleetDir, configDir }),
    ).rejects.toThrow('escapes its declared scope');

    const link = path.join(repoDir, '.conductor', 'linked.yaml');
    await symlink(outside, link);
    const linked: Settings = {
      defaultProfile: 'worker',
      profiles: { worker: { sources: [{ scope: 'repo', file: '.conductor/linked.yaml', profile: 'worker' }] } },
    };
    await expect(
      prepareDeclaredMcp({ settings: linked, session: session(), fleetBase: fleetDir, configDir }),
    ).rejects.toThrow('through a symlink');

    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), {
      version: 1,
      id: 'path-escape',
      servers: [
        {
          id: 'optional-local',
          transport: 'stdio',
          command: 'node',
          cwd: '..',
          required: false,
        },
      ],
      profiles: { worker: { servers: ['optional-local'] } },
    });
    await expect(
      prepareDeclaredMcp({ settings: settings(), session: session(), fleetBase: fleetDir, configDir }),
    ).rejects.toThrow("cwd for declared MCP server 'optional-local' escapes its declared scope");

    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), {
      version: 1,
      id: 'command-escape',
      servers: [
        {
          id: 'optional-local',
          transport: 'stdio',
          command: '../outside-command',
          required: false,
        },
      ],
      profiles: { worker: { servers: ['optional-local'] } },
    });
    await expect(
      prepareDeclaredMcp({ settings: settings(), session: session(), fleetBase: fleetDir, configDir }),
    ).rejects.toThrow("command for declared MCP server 'optional-local' escapes its declared scope");
  });

  it('rejects duplicate IDs across project and fleet sources', async () => {
    await writeManifest(path.join(repoDir, '.conductor', 'mcp.yaml'), projectManifest);
    await writeManifest(path.join(fleetDir, '.conductor', 'config', 'mcp-engineering-manager.yaml'), {
      ...overlayManifest,
      servers: [{ ...overlayManifest.servers[0], id: 'project-api' }],
      profiles: { 'engineering-manager': { servers: ['project-api'] } },
    });
    await expect(
      prepareDeclaredMcp({
        settings: settings(),
        session: session('engineering-manager'),
        fleetBase: fleetDir,
        configDir,
      }),
    ).rejects.toThrow("Duplicate declared MCP server ID 'project-api'");
  });
});

describe('Codex config isolation helpers', () => {
  it('strips shared MCP tables while preserving unrelated config and discovers project IDs', () => {
    const shared = [
      'model = "gpt-test"',
      '[mcp_servers.slack]',
      'url = "https://slack.example.test/mcp"',
      '[mcp_servers.slack.tools.search]',
      'approval_mode = "approve"',
      '[tui]',
      'animations = false',
      '',
    ].join('\n');
    expect(stripMcpServerConfig(shared)).toBe('model = "gpt-test"\n[tui]\nanimations = false\n');
    expect(discoverMcpServerIds(shared)).toEqual(['slack']);
    expect(discoverMcpServerIds('[mcp_servers]\nlinear.url = "https://example.test"\n')).toEqual(['linear']);
  });

  it('fails closed on unsupported inline MCP-table syntax', () => {
    expect(() => stripMcpServerConfig('mcp_servers = { slack = { url = "https://example.test" } }\n')).toThrow(
      'unsupported root-level',
    );
    expect(() => discoverMcpServerIds('mcp_servers = { slack = { url = "https://example.test" } }\n')).toThrow(
      'unsupported inline',
    );
  });
});

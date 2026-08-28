#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function args() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--'))
      throw new Error('Arguments must be --key value');
    values.set(key.slice(2), value);
  }
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing --${key}`);
    return value;
  };
  return {
    artifact: resolve(required('artifact')),
    output: resolve(required('output')),
    variant: required('variant'),
    count: Number(required('count')),
    cycles: Number(values.get('cycles') ?? '30'),
    sampleSeconds: Number(values.get('sample-seconds') ?? '60'),
    settleMaxSeconds: Number(values.get('settle-max-seconds') ?? '300'),
    settleWindowSeconds: Number(values.get('settle-window-seconds') ?? '30'),
    cycleStartIntervalSeconds: values.has('cycle-start-interval-seconds')
      ? Number(values.get('cycle-start-interval-seconds'))
      : undefined,
    windowId: values.has('window-id') ? Number(values.get('window-id')) : undefined,
  };
}

const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function hashTree(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(path.slice(root.length));
        hash.update(await readFile(path));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function shimSource(binary, categoryExpression) {
  return `#!/bin/sh
category=${categoryExpression}
script_hash=$(/usr/bin/printf '%s' "$*" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
/usr/bin/printf '{"timestamp":"%s","cycle":"%s","parentPid":%s,"category":"%s","argvHash":"%s"}\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "${'${CONDUCTOR_SHAKEDOWN_CYCLE_ID:-setup}'}" "$PPID" "$category" "$script_hash" >> "${'${CONDUCTOR_SHAKEDOWN_PROBE_LOG}'}"
exec ${binary} "$@"
`;
}

async function installShims(root, logPath) {
  const shimDir = join(root, 'shim');
  await mkdir(shimDir);
  const osa = join(shimDir, 'osascript');
  const ps = join(shimDir, 'ps');
  await writeFile(
    osa,
    shimSource(
      '/usr/bin/osascript',
      `'other'; case "$*" in *CONDUCTOR_ITERM_LIVENESS_V1*) category='liveness' ;; *return*ALIVE*) category='scalar-existence' ;; *tty*as*string*) category='scalar-tty' ;; *contents*string*) category='activity-capture' ;; esac`,
    ),
  );
  await writeFile(ps, shimSource('/bin/ps', `'process-table'`));
  await chmod(osa, 0o755);
  await chmod(ps, 0o755);
  process.env.CONDUCTOR_SHAKEDOWN_PROBE_LOG = logPath;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'validation';
  await execFile('osascript', ['-e', 'return "OK"']);
  await execFile('ps', ['-o', 'pid=', '-p', String(process.pid)]);
  return shimDir;
}

async function itermPid() {
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,comm=']);
  const pids = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\/Applications\/iTerm\.app\/Contents\/MacOS\/iTerm2)\s*$/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (pids.length !== 1) throw new Error(`Expected exactly one iTerm2 PID, found ${String(pids.length)}`);
  return Number(pids[0]);
}

async function frontmostBundleId() {
  const { stdout: front } = await execFile('/usr/bin/lsappinfo', ['front']);
  const { stdout: info } = await execFile('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', front.trim()]);
  return /"CFBundleIdentifier"="([^"]+)"/u.exec(info)?.[1];
}

async function preservingUserFocus(action, windowId) {
  const before = await frontmostBundleId().catch(() => undefined);
  const result = await action();
  if (windowId !== undefined) {
    const script = `tell application "iTerm2" to set miniaturized of window id ${String(windowId)} to true`;
    await execFile('/usr/bin/osascript', ['-e', script]).catch(() => undefined);
  }
  const after = await frontmostBundleId().catch(() => undefined);
  if (before !== undefined && after !== before) {
    await execFile('/usr/bin/open', ['-b', before]).catch(() => undefined);
  }
  return result;
}

async function ttyProcesses(ttyPath) {
  const tty = basename(ttyPath);
  try {
    const { stdout } = await execFile('/bin/ps', ['-o', 'pid=,ppid=,pgid=,tpgid=,comm=,args=', '-t', tty], {
      timeout: 5000,
    });
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
      if (match === null) return [];
      return [
        {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          processGroupId: Number(match[3]),
          foregroundProcessGroupId: Number(match[4]),
          command: match[5] ?? '',
          args: (match[6] ?? '').trim(),
        },
      ];
    });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 1) return [];
    throw error;
  }
}

async function waitForTty(ttyPath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = await ttyProcesses(ttyPath);
    if (predicate(rows)) return rows;
    if (Date.now() >= deadline) return rows;
    await pause(100);
  }
}

async function terminateHarnessPane(backend, pane, ttyPath) {
  if (ttyPath === undefined) {
    await backend.kill(pane);
    return;
  }
  let rows = await ttyProcesses(ttyPath);
  const sleeps = rows.filter(
    (row) => basename(row.command) === 'sleep' && row.args === 'sleep 900' && row.processGroupId === row.pid,
  );
  if (sleeps.length > 1) throw new Error(`Multiple harness jobs found on ${ttyPath}`);
  if (sleeps[0] !== undefined) {
    process.kill(-sleeps[0].processGroupId, 'SIGTERM');
    rows = await waitForTty(
      ttyPath,
      (current) => !current.some((row) => basename(row.command) === 'sleep' && row.args === 'sleep 900'),
      2000,
    );
    const remainingSleep = rows.find((row) => basename(row.command) === 'sleep' && row.args === 'sleep 900');
    if (remainingSleep !== undefined) {
      process.kill(-remainingSleep.processGroupId, 'SIGKILL');
      rows = await waitForTty(
        ttyPath,
        (current) => !current.some((row) => basename(row.command) === 'sleep' && row.args === 'sleep 900'),
        2000,
      );
    }
  }
  await backend.run(pane, 'exit').catch(() => undefined);
  rows = await waitForTty(ttyPath, (current) => current.length === 0, 2000);
  if (rows.length > 0) {
    const login = rows.find((row) => basename(row.command) === 'login' && row.args === 'login -fp ianlancaster');
    const shell = rows.find((row) => basename(row.command).replace(/^-+/u, '') === 'zsh' && row.args === '-zsh');
    if (rows.length !== 2 || login === undefined || shell === undefined || shell.parentPid !== login.pid) {
      throw new Error(`Refusing to terminate unexpected processes on harness tty ${ttyPath}`);
    }
    process.kill(-shell.processGroupId, 'SIGKILL');
    rows = await waitForTty(ttyPath, (current) => current.length === 0, 2000);
    if (rows.length > 0) throw new Error(`Harness tty ${ttyPath} still has processes after cleanup`);
  }
  await backend.kill(pane);
}

async function sampleProcess(pid) {
  const { stdout } = await execFile('/bin/ps', ['-o', '%cpu=,rss=', '-p', String(pid)]);
  const match = /^\s*([0-9.]+)\s+(\d+)\s*$/.exec(stdout);
  if (match === null) throw new Error('Could not parse iTerm2 CPU/RSS sample');
  return { at: new Date().toISOString(), cpuPercent: Number(match[1]), rssKiB: Number(match[2]) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

async function sampleWindow(pid, seconds) {
  const samples = [];
  for (let index = 0; index < seconds; index += 1) {
    samples.push(await sampleProcess(pid));
    if (index + 1 < seconds) await pause(1000);
  }
  return samples;
}

async function settleRss(pid, maximumSeconds, windowSeconds) {
  const windows = [];
  while (windows.length * windowSeconds < maximumSeconds) {
    const samples = await sampleWindow(pid, windowSeconds);
    const current = median(samples.map((sample) => sample.rssKiB));
    windows.push({ medianRssKiB: current, samples });
    const prior = windows.at(-2)?.medianRssKiB;
    if (prior !== undefined && Math.abs(current - prior) / Math.max(prior, 1) <= 0.02) {
      return { settled: true, windows };
    }
  }
  return { settled: false, windows };
}

async function main() {
  const options = args();
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) throw new Error('Invalid count');
  if (
    options.cycleStartIntervalSeconds !== undefined &&
    (!Number.isFinite(options.cycleStartIntervalSeconds) || options.cycleStartIntervalSeconds <= 0)
  ) {
    throw new Error('Invalid cycle start interval');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'conductor-iterm-scaling-'));
  await mkdir(dirname(options.output), { recursive: true });
  const probeLog = options.output.replace(/\.json$/u, '.probes.jsonl');
  await writeFile(probeLog, '');
  const runnerHash = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex');
  await installShims(scratch, probeLog);

  const [{ ITermBackend }, { Lifecycle }, { SessionStateManager }, { Store }, { DeliveryQueue }, processHelpers] =
    await Promise.all([
      import(pathToFileURL(join(options.artifact, 'terminals/iterm/index.js')).href),
      import(pathToFileURL(join(options.artifact, 'core/lifecycle.js')).href),
      import(pathToFileURL(join(options.artifact, 'core/state.js')).href),
      import(pathToFileURL(join(options.artifact, 'store/index.js')).href),
      import(pathToFileURL(join(options.artifact, 'core/delivery.js')).href),
      import(pathToFileURL(join(options.artifact, 'terminals/process.js')).href),
    ]);
  const store = new Store(join(scratch, 'state.db'));
  if (options.windowId !== undefined) {
    if (!Number.isInteger(options.windowId) || options.windowId < 1) throw new Error('Invalid window id');
    store.setWorkspaceValue('iterm.windowId', options.windowId);
  }
  const terminalEnv = { ...process.env };
  delete terminalEnv.CONDUCTOR_CONSOLE_TTY;
  const backend = new ITermBackend({
    store,
    env: terminalEnv,
    config: {
      windowName: `Conductor liveness shakedown ${String(process.pid)}`,
      fleetId: `shakedown-${String(process.pid)}`,
      badge: false,
      focusNewPanes: false,
      bracketedPasteThreshold: 512,
      launchTimeoutSec: 5,
      pollIntervalSec: 0.1,
    },
  });
  const panes = [];
  const ownedTtys = new Map();
  try {
    await backend.init();
    for (let index = 0; index < options.count; index += 1) {
      const codename = `probe-${String(index + 1)}`;
      panes.push([
        codename,
        await preservingUserFocus(() => backend.createPane(codename, index === 0 ? 'pane' : 'tab'), options.windowId),
      ]);
    }
    await pause(1000);
    for (const [, pane] of panes) {
      await backend.launch(pane, 'sleep 900');
      const tty = await backend.sessionTty(pane.id);
      if (tty === null) throw new Error('Created harness pane has no tty');
      ownedTtys.set(pane.id, tty);
    }
    await pause(500);
    for (const [, pane] of panes) {
      if (!(await backend.isSessionActive(pane))) throw new Error('Disposable foreground command did not start');
    }
    let batchDiagnostic;
    if (typeof backend.snapshotLiveness === 'function') {
      process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'batch-diagnostic';
      const pane = panes[0]?.[1];
      const tty = pane === undefined ? null : await backend.sessionTty(pane.id);
      const direct = tty === null ? new Map() : await processHelpers.ttysHaveForegroundJobs([tty]);
      const snapshot = await backend.snapshotLiveness(
        panes.map(([, requestedPane]) => requestedPane),
        { includeSessionActivity: true },
      );
      batchDiagnostic = {
        directProcessEntries: direct.size,
        snapshotActivities: panes.map(([, requestedPane]) => snapshot.get(requestedPane.id)?.activity?.state ?? 'none'),
      };
    }

    const sessions = new Map(
      panes.map(([codename]) => [
        codename,
        { codename, repo: scratch, runtime: 'codex', additionalDirs: [], schedules: [] },
      ]),
    );
    const states = new SessionStateManager(store, false);
    for (const [codename] of panes) states.register(codename, false);
    const lifecycle = new Lifecycle({
      store,
      backend,
      states,
      runtimes: new Map(),
      sessions: () => sessions,
      identityFor: () => ({ mcpUrl: '', eventsUrl: '', configDir: scratch }),
      config: {
        defaultPlacement: 'pane',
        defaultRuntime: 'codex',
        defaultEfforts: {},
        defaultBypassPermissions: false,
        markerFile: '.agent-project',
        spawnDirPattern: '{codename}',
        spawnTemplates: {},
        templateCloneTimeoutMs: 1,
      },
      baseDir: scratch,
      sessionConfigDir: scratch,
      reloadSessions: () => undefined,
      supervisionReset: () => undefined,
      reconcileActivity: async (_session, pane) => {
        await backend.capture(pane, 5);
      },
    });
    for (const [codename, pane] of panes) await lifecycle.adopt(codename, pane);

    const hasBatch = typeof backend.snapshotLiveness === 'function';
    if (options.variant === 'candidate' && !hasBatch) throw new Error('Candidate artifact has no snapshotLiveness');
    if (options.variant === 'baseline' && hasBatch)
      throw new Error('Baseline artifact unexpectedly has snapshotLiveness');
    const iTerm2Pid = await itermPid();
    const power = (await execFile('/usr/bin/pmset', ['-g', 'batt'])).stdout.trim();
    const thermal = (await execFile('/usr/bin/pmset', ['-g', 'therm'])).stdout.trim();

    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'warmup';
    for (let index = 0; index < 5; index += 1) await lifecycle.reconcile();
    const settled = await settleRss(iTerm2Pid, options.settleMaxSeconds, options.settleWindowSeconds);
    if (!settled.settled) throw new Error('iTerm2 RSS did not settle within the configured maximum');

    const samplesPromise = sampleWindow(iTerm2Pid, options.sampleSeconds);
    const latenciesMs = [];
    const starts = [];
    const scheduleStarted = process.hrtime.bigint();
    for (let index = 0; index < options.cycles; index += 1) {
      const scheduledOffsetMs =
        options.cycleStartIntervalSeconds === undefined ? undefined : index * options.cycleStartIntervalSeconds * 1000;
      if (scheduledOffsetMs !== undefined) {
        const elapsedMs = Number(process.hrtime.bigint() - scheduleStarted) / 1_000_000;
        if (elapsedMs < scheduledOffsetMs) await pause(scheduledOffsetMs - elapsedMs);
      }
      process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = `measure-${String(index + 1)}`;
      const started = process.hrtime.bigint();
      await lifecycle.reconcile();
      latenciesMs.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      const actualStartOffsetMs = Number(started - scheduleStarted) / 1_000_000;
      starts.push({
        actualStartOffsetMs,
        ...(scheduledOffsetMs === undefined
          ? {}
          : { scheduledOffsetMs, startLagMs: actualStartOffsetMs - scheduledOffsetMs }),
      });
      if (options.cycleStartIntervalSeconds === undefined && index + 1 < options.cycles) await pause(1000);
    }
    const samples = await samplesPromise;

    const paneFor = (session) => panes.find(([codename]) => codename === session)?.[1];
    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'existence-setup';
    const queue = new DeliveryQueue({
      backend,
      isPaused: () => true,
      runtimeFor: () => ({
        name: 'shakedown',
        capabilities: {
          resume: false,
          targetedResume: false,
          styledCapture: false,
          authoritativeTurnCompletion: false,
        },
        prepare: async () => undefined,
        buildLaunchCommand: () => '',
        parseInputState: () => 'draft',
        stripChrome: (value) => value,
      }),
      getPane: paneFor,
      config: { queueDrainMs: 3_600_000 },
    });
    for (const [codename] of panes) await queue.deliverOrQueue(codename, 'measurement-only', { automated: true });
    queue.stop();
    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'existence-only';
    await queue.drainNow();
    queue.stop();

    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'positive-control';
    for (const [, pane] of panes) {
      if (await backend.isAlive(pane)) await backend.isSessionActive(pane);
    }

    const missingTrials = [];
    for (const [label, missingCount] of [
      ['one', 1],
      ['several', Math.ceil(options.count / 2)],
      ['all', options.count],
    ]) {
      const selected = panes.slice(0, missingCount);
      for (const [, pane] of selected) await terminateHarnessPane(backend, pane, ownedTtys.get(pane.id));
      process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = `missing-${label}-setup`;
      for (const [, pane] of selected) {
        const deadline = Date.now() + 5000;
        while (await backend.isAlive(pane)) {
          if (Date.now() >= deadline) throw new Error('Disposable pane did not close before missing trial');
          await pause(100);
        }
      }
      process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = `missing-${label}`;
      const started = process.hrtime.bigint();
      await lifecycle.reconcile();
      missingTrials.push({ label, missingCount, latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000 });
      if (label !== 'all') {
        process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = `missing-${label}-recovery`;
        for (let index = 0; index < missingCount; index += 1) {
          const codename = panes[index]?.[0];
          if (codename === undefined) continue;
          const replacement = await preservingUserFocus(
            () => backend.createPane(codename, index === 0 && missingCount === options.count ? 'pane' : 'tab'),
            options.windowId,
          );
          await backend.launch(replacement, 'sleep 900');
          const tty = await backend.sessionTty(replacement.id);
          if (tty === null) throw new Error('Replacement harness pane has no tty');
          ownedTtys.set(replacement.id, tty);
          panes[index] = [codename, replacement];
          await lifecycle.adopt(codename, replacement);
        }
        await pause(500);
      }
    }
    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'complete';

    const probeLines = (await readFile(probeLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const measured = probeLines.filter((record) => String(record.cycle).startsWith('measure-'));
    const perCycle = Array.from({ length: options.cycles }, (_, index) => {
      const cycle = `measure-${String(index + 1)}`;
      const records = measured.filter((record) => record.cycle === cycle);
      const osaLiveness = records.filter((record) =>
        ['liveness', 'scalar-existence', 'scalar-tty'].includes(record.category),
      ).length;
      const osaActivityCapture = records.filter((record) => record.category === 'activity-capture').length;
      const observedPs = records.filter((record) => record.category === 'process-table').length;
      return {
        cycle,
        osascriptLiveness: osaLiveness,
        inferredTreeWalks: osaLiveness,
        osascriptActivityCapture: osaActivityCapture,
        observedPs,
        inferredAbsolutePs: hasBatch ? 1 : 0,
        totalProbeProcesses: osaLiveness + osaActivityCapture + observedPs + (hasBatch ? 1 : 0),
        latencyMs: latenciesMs[index],
        ...starts[index],
      };
    });
    const positive = probeLines.filter((record) => record.cycle === 'positive-control');
    const countCycle = (cycle) => {
      const records = probeLines.filter((record) => record.cycle === cycle);
      const liveness = records.filter((record) =>
        ['liveness', 'scalar-existence', 'scalar-tty'].includes(record.category),
      ).length;
      return {
        osascriptLiveness: liveness,
        inferredTreeWalks: liveness,
        osascriptActivityCapture: records.filter((record) => record.category === 'activity-capture').length,
        observedPs: records.filter((record) => record.category === 'process-table').length,
      };
    };
    const output = {
      schema: 'conductor-iterm-liveness-scaling-v1',
      createdAt: new Date().toISOString(),
      variant: options.variant,
      count: options.count,
      cycles: options.cycles,
      artifact: options.artifact,
      artifactHash: await hashTree(options.artifact),
      runnerHash,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      iTerm2Pid,
      systemContext: { power, thermal },
      batchDiagnostic,
      settled,
      samples,
      measurement: {
        mode: options.cycleStartIntervalSeconds === undefined ? 'completion-relative' : 'fixed-start-cadence',
        cycleStartIntervalSeconds: options.cycleStartIntervalSeconds ?? null,
        sampleSeconds: options.sampleSeconds,
      },
      perCycle,
      existenceOnly: countCycle('existence-only'),
      missingTrials: missingTrials.map((trial) => ({
        ...trial,
        ...countCycle(`missing-${trial.label}`),
        inferredAbsolutePs: hasBatch && trial.missingCount < options.count ? 1 : 0,
      })),
      positiveControl: {
        osascriptLiveness: positive.filter((record) =>
          ['liveness', 'scalar-existence', 'scalar-tty'].includes(record.category),
        ).length,
        observedPs: positive.filter((record) => record.category === 'process-table').length,
      },
      probeLog,
      cleanupAssertion: options.output.replace(/\.json$/u, '.cleanup.json'),
      limitations: [
        'Candidate batch ps uses the production absolute /bin/ps path, so its one process is inferred from the exercised code path and focused command-shape tests rather than the PATH shim.',
      ],
    };
    await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${options.output}\n`);
  } finally {
    process.env.CONDUCTOR_SHAKEDOWN_CYCLE_ID = 'cleanup';
    const cleanupFailures = [];
    for (const [, pane] of panes.reverse()) {
      try {
        await terminateHarnessPane(backend, pane, ownedTtys.get(pane.id));
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const leftovers = [];
    for (const tty of new Set(ownedTtys.values())) {
      const rows = await ttyProcesses(tty);
      if (rows.length > 0) leftovers.push({ tty, processCount: rows.length });
    }
    const cleanupPassed = cleanupFailures.length === 0 && leftovers.length === 0;
    if (!cleanupPassed) {
      process.stderr.write(`Harness cleanup assertion failed: ${JSON.stringify({ cleanupFailures, leftovers })}\n`);
      process.exitCode = 1;
    }
    await writeFile(
      options.output.replace(/\.json$/u, '.cleanup.json'),
      `${JSON.stringify(
        {
          passed: cleanupPassed,
          ownedTtyCount: new Set(ownedTtys.values()).size,
          remainingProcessCount: leftovers.reduce((total, item) => total + item.processCount, 0),
          cleanupFailures,
          leftovers,
        },
        null,
        2,
      )}\n`,
    );
    store.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();

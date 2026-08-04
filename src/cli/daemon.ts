import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fleetSlug } from '../config/derived-defaults.js';
import { loadSupervisorConfig } from '../config/loader.js';
import { resolveConductorInstance, resolveFleetDataDir } from '../config/paths.js';
import { stableConductorExecutable } from './doctor.js';

// Service names embed the fleet slug so each fleet directory can run its own
// daemon — a fixed label would make the second `daemon install` silently
// replace the first fleet's service.
export function launchdLabel(baseDir: string, instance?: string): string {
  return `com.agent-conductor.${fleetSlug(baseDir, instance)}`;
}

export function systemdUnit(baseDir: string, instance?: string): string {
  return `agent-conductor-${fleetSlug(baseDir, instance)}.service`;
}

function launchdPlistPath(baseDir: string, instance?: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(baseDir, instance)}.plist`);
}

function systemdUnitPath(baseDir: string, instance?: string): string {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnit(baseDir, instance));
}

function conductorBin(): string {
  return process.argv[1] ?? 'conductor';
}

export function renderLaunchdPlist(
  baseDir: string,
  dataDir: string,
  instance?: string,
  executable = process.execPath,
  conductorExecutable = conductorBin(),
): string {
  const instanceArgs = instance === undefined ? [] : ['--instance', instance];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(baseDir, instance)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executable}</string>
    <string>${conductorExecutable}</string>
${instanceArgs.map((arg) => `    <string>${arg}</string>`).join('\n')}${instanceArgs.length > 0 ? '\n' : ''}    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key><string>${baseDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(dataDir, 'daemon.stdout.log')}</string>
  <key>StandardErrorPath</key><string>${join(dataDir, 'daemon.stderr.log')}</string>
</dict>
</plist>
`;
}

export function renderSystemdService(
  baseDir: string,
  instance?: string,
  executable = process.execPath,
  conductorExecutable = conductorBin(),
): string {
  return `[Unit]
Description=agent-conductor supervisor (${fleetSlug(baseDir, instance)})
After=network.target

[Service]
Type=simple
WorkingDirectory=${baseDir}
ExecStart=${executable} ${conductorExecutable}${instance === undefined ? '' : ` --instance ${instance}`} start --foreground
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function installDaemon(baseDir: string, instance?: string): string {
  if (!stableConductorExecutable(conductorBin())) {
    throw new Error(
      'Daemon installation requires a stable global Conductor executable. Install the packaged release globally, then rerun `conductor daemon install`.',
    );
  }
  const resolvedInstance = resolveConductorInstance(baseDir, instance);
  const config = loadSupervisorConfig(resolvedInstance);
  const dataDir = resolveFleetDataDir(baseDir, config.paths.dataDir);
  mkdirSync(dataDir, { recursive: true });
  if (platform() === 'darwin') {
    const plist = renderLaunchdPlist(baseDir, dataDir, instance);
    const path = launchdPlistPath(baseDir, instance);
    writeFileSync(path, plist);
    execFileSync('launchctl', ['load', path]);
    return `Installed and loaded ${path}`;
  }

  const unit = renderSystemdService(baseDir, instance);
  const path = systemdUnitPath(baseDir, instance);
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(path, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', systemdUnit(baseDir, instance)]);
  return `Installed and started ${path}`;
}

export function uninstallDaemon(baseDir: string, instance?: string): string {
  if (platform() === 'darwin') {
    const path = launchdPlistPath(baseDir, instance);
    if (!existsSync(path)) return 'No launchd service installed for this fleet directory.';
    try {
      execFileSync('launchctl', ['unload', path]);
    } catch {
      // Not loaded — fine.
    }
    unlinkSync(path);
    return `Removed ${path}`;
  }
  const path = systemdUnitPath(baseDir, instance);
  if (!existsSync(path)) return 'No systemd service installed for this fleet directory.';
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', systemdUnit(baseDir, instance)]);
  } catch {
    // Not enabled — fine.
  }
  unlinkSync(path);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  return `Removed ${path}`;
}

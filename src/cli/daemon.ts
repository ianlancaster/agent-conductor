import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fleetSlug } from '../config/instance.js';

// Service names embed the fleet slug so each fleet directory can run its own
// daemon — a fixed label would make the second `daemon install` silently
// replace the first fleet's service.
function launchdLabel(baseDir: string): string {
  return `com.agent-conductor.${fleetSlug(baseDir)}`;
}

function systemdUnit(baseDir: string): string {
  return `agent-conductor-${fleetSlug(baseDir)}.service`;
}

function launchdPlistPath(baseDir: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(baseDir)}.plist`);
}

function systemdUnitPath(baseDir: string): string {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnit(baseDir));
}

function conductorBin(): string {
  return process.argv[1] ?? 'conductor';
}

export function installDaemon(baseDir: string): string {
  if (platform() === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel(baseDir)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${conductorBin()}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key><string>${baseDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(baseDir, 'data', 'daemon.stdout.log')}</string>
  <key>StandardErrorPath</key><string>${join(baseDir, 'data', 'daemon.stderr.log')}</string>
</dict>
</plist>
`;
    const path = launchdPlistPath(baseDir);
    writeFileSync(path, plist);
    execFileSync('launchctl', ['load', path]);
    return `Installed and loaded ${path}`;
  }

  const unit = `[Unit]
Description=agent-conductor supervisor (${fleetSlug(baseDir)})
After=network.target

[Service]
Type=simple
WorkingDirectory=${baseDir}
ExecStart=${process.execPath} ${conductorBin()} start --foreground
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  const path = systemdUnitPath(baseDir);
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(path, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', systemdUnit(baseDir)]);
  return `Installed and started ${path}`;
}

export function uninstallDaemon(baseDir: string): string {
  if (platform() === 'darwin') {
    const path = launchdPlistPath(baseDir);
    if (!existsSync(path)) return 'No launchd service installed for this fleet directory.';
    try {
      execFileSync('launchctl', ['unload', path]);
    } catch {
      // Not loaded — fine.
    }
    unlinkSync(path);
    return `Removed ${path}`;
  }
  const path = systemdUnitPath(baseDir);
  if (!existsSync(path)) return 'No systemd service installed for this fleet directory.';
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', systemdUnit(baseDir)]);
  } catch {
    // Not enabled — fine.
  }
  unlinkSync(path);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  return `Removed ${path}`;
}

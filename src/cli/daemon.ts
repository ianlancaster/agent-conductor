import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const LAUNCHD_LABEL = 'com.agent-conductor.local';
const SYSTEMD_UNIT = 'agent-conductor.service';

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
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
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${conductorBin()}</string>
    <string>start</string>
    <string>--no-console</string>
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
    const path = launchdPlistPath();
    writeFileSync(path, plist);
    execFileSync('launchctl', ['load', path]);
    return `Installed and loaded ${path}`;
  }

  const unit = `[Unit]
Description=agent-conductor supervisor
After=network.target

[Service]
Type=simple
WorkingDirectory=${baseDir}
ExecStart=${process.execPath} ${conductorBin()} start --no-console
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  const path = systemdUnitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(path, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
  return `Installed and started ${path}`;
}

export function uninstallDaemon(): string {
  if (platform() === 'darwin') {
    const path = launchdPlistPath();
    if (!existsSync(path)) return 'No launchd service installed.';
    try {
      execFileSync('launchctl', ['unload', path]);
    } catch {
      // Not loaded — fine.
    }
    unlinkSync(path);
    return `Removed ${path}`;
  }
  const path = systemdUnitPath();
  if (!existsSync(path)) return 'No systemd service installed.';
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  } catch {
    // Not enabled — fine.
  }
  unlinkSync(path);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  return `Removed ${path}`;
}

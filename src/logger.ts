import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface LoggerOptions {
  level?: LogLevel;
  filePath?: string;
}

export class Logger {
  private readonly threshold: number;
  private readonly filePath: string | undefined;
  private consoleEnabled = true;

  constructor(opts: LoggerOptions = {}) {
    this.threshold = LEVELS[opts.level ?? 'info'];
    this.filePath = opts.filePath;
  }

  /** Disable console output (e.g. while an interactive readline owns the terminal). */
  setConsoleEnabled(enabled: boolean): void {
    this.consoleEnabled = enabled;
  }

  debug(scope: string, message: string): void {
    this.write('debug', scope, message);
  }

  info(scope: string, message: string): void {
    this.write('info', scope, message);
  }

  warn(scope: string, message: string): void {
    this.write('warn', scope, message);
  }

  error(scope: string, message: string): void {
    this.write('error', scope, message);
  }

  private write(level: LogLevel, scope: string, message: string): void {
    if (LEVELS[level] < this.threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (this.consoleEnabled) {
      console.error(`${COLORS[level]}${line}${RESET}`);
    }
    if (this.filePath !== undefined) {
      try {
        appendFileSync(this.filePath, `${line}\n`);
      } catch {
        // Logging must never take the process down.
      }
    }
  }
}

let globalLogger = new Logger();

export function initLogger(opts: LoggerOptions): Logger {
  globalLogger = new Logger(opts);
  return globalLogger;
}

export function log(): Logger {
  return globalLogger;
}

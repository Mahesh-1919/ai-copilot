type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinLevel(): Level {
  const fromEnv = process.env.LOG_LEVEL?.toLowerCase();
  if (fromEnv && fromEnv in LEVEL_ORDER) return fromEnv as Level;
  return process.argv.includes('--dev') ? 'debug' : 'info';
}

const minLevel = resolveMinLevel();

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const emit = (level: Level, args: unknown[]) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const sink = level === 'debug' ? console.log : console[level];
    sink(prefix, ...args);
  };
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

/**
 * When the app is launched without a terminal (tray / login item), stdout and
 * stderr can be closed pipes; writing to them would raise EPIPE and crash.
 */
export function ignoreBrokenPipes(): void {
  const ignoreEpipe = (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  };
  process.stdout.on('error', ignoreEpipe);
  process.stderr.on('error', ignoreEpipe);
}

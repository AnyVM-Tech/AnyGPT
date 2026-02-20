export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function resolveLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase().trim();
  if (raw in levelOrder) return raw as LogLevel;
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') return 'info';
  return 'debug';
}

const currentLevel = resolveLogLevel();

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

function formatArgs(level: LogLevel, args: unknown[]): unknown[] {
  const prefix = `[${level.toUpperCase()}]`;
  if (args.length === 0) return [prefix];
  if (typeof args[0] === 'string') {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (shouldLog('debug')) console.debug(...formatArgs('debug', args));
  },
  info: (...args: unknown[]) => {
    if (shouldLog('info')) console.info(...formatArgs('info', args));
  },
  warn: (...args: unknown[]) => {
    if (shouldLog('warn')) console.warn(...formatArgs('warn', args));
  },
  error: (...args: unknown[]) => {
    if (shouldLog('error')) console.error(...formatArgs('error', args));
  },
};

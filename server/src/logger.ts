/**
 * 极简结构化日志：级别 + 时间戳 + 作用域 + key=value meta，单行输出，方便 tail / grep。
 *
 * 用法：
 *   const log = createLogger('track');
 *   log.info('伴奏入库', { id, title });
 *   log.error('上传处理失败', { error });
 *
 * LOG_LEVEL=debug|info|warn|error 控制详细程度（默认 info）。
 * 输出到 stdout（debug/info）和 stderr（warn/error）——
 * openktv.sh 会把两者一起收进 .run/openktv.log，重定向时自动去掉颜色。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_NAMES = Object.keys(LEVEL_PRIORITY) as LogLevel[];

/** 解析 LOG_LEVEL（大小写不敏感）；非法值回落 fallback */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const value = (raw ?? '').trim().toLowerCase();
  return (LEVEL_NAMES as string[]).includes(value) ? (value as LogLevel) : fallback;
}

export type LogMeta = Record<string, unknown>;

/** (整行文本, 级别)。测试里注入捕获数组即可断言日志内容 */
export type LogSink = (line: string, level: LogLevel) => void;

export interface LogEntry {
  /** ISO 8601 字符串 */
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: LogMeta;
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** 派生子的作用域：scope:child */
  child(scope: string): Logger;
}

export interface CreateLoggerOptions {
  /** 不传则读 LOG_LEVEL 环境变量 */
  level?: LogLevel;
  /** 不传则写 stdout / stderr */
  sink?: LogSink;
  /** 注入时钟，测试用 */
  now?: () => Date;
}

/** 单个 meta 值渲染成的最大长度，超了截断，别把日志刷爆 */
const MAX_META_CHARS = 300;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\u001b[2m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const COLOR_RESET = '\u001b[0m';

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY || process.stderr.isTTY) || Boolean(process.env.FORCE_COLOR);
}

const defaultSink: LogSink = (line, level) => {
  const text = colorEnabled() ? `${LEVEL_COLOR[level]}${line}${COLOR_RESET}` : line;
  if (level === 'warn' || level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
};

/** 单个 meta 值的单行渲染；debug 级别给 Error 附上首个栈帧方便定位 */
export function formatMetaValue(value: unknown, level?: LogLevel): string {
  if (value instanceof Error) {
    const base = `${value.name}: ${value.message}`;
    if (level !== 'debug') return base;
    const frame = (value.stack ?? '').split('\n')[1]?.trim();
    return frame ? `${base} (${frame})` : base;
  }
  if (typeof value === 'string') return /\s/.test(value) ? `"${value}"` : value;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 纯函数：日志条目 → 单行文本 */
export function formatLogLine(entry: LogEntry): string {
  const head = `${entry.time} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`;
  const parts = [head];
  for (const [key, value] of Object.entries(entry.meta ?? {})) {
    if (value === undefined) continue;
    const rendered = formatMetaValue(value, entry.level);
    parts.push(`${key}=${rendered.length > MAX_META_CHARS ? `${rendered.slice(0, MAX_META_CHARS)}…` : rendered}`);
  }
  return parts.join(' ');
}

export function createLogger(scope: string, options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.LOG_LEVEL);
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_PRIORITY[level];

  const emit = (entryLevel: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_PRIORITY[entryLevel] < threshold) return;
    sink(
      formatLogLine({ time: now().toISOString(), level: entryLevel, scope, message, meta }),
      entryLevel,
    );
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (sub) => createLogger(`${scope}:${sub}`, { level, sink, now }),
  };
}

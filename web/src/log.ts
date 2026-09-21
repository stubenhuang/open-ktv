/**
 * 前端极简日志：开发环境 debug 起，生产构建只留 warn/error。
 *
 * 和服务端 logger.ts 同一套形状（作用域 + 级别），但刻意保持零依赖、零配置。
 * 注意：正常流程里不要调 log.error —— e2e 会把浏览器 console.error 当失败，
 * 要报错给用户就走页面上的错误提示。
 */

type ClientLevel = 'debug' | 'info' | 'warn' | 'error';

const PRIORITY: Record<ClientLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CONSOLE: Record<ClientLevel, (...args: unknown[]) => void> = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** 开发构建详细、生产构建安静；VITE_LOG_LEVEL 可强制覆盖 */
function currentLevel(): ClientLevel {
  const override = import.meta.env.VITE_LOG_LEVEL;
  if (
    override === 'debug' ||
    override === 'info' ||
    override === 'warn' ||
    override === 'error'
  ) {
    return override;
  }
  return import.meta.env.DEV ? 'debug' : 'warn';
}

function emit(level: ClientLevel, scope: string, message: string, ...args: unknown[]): void {
  if (PRIORITY[level] < PRIORITY[currentLevel()]) return;
  CONSOLE[level](`[ktv:${scope}]`, message, ...args);
}

export const log = {
  debug: (scope: string, message: string, ...args: unknown[]) =>
    emit('debug', scope, message, ...args),
  info: (scope: string, message: string, ...args: unknown[]) =>
    emit('info', scope, message, ...args),
  warn: (scope: string, message: string, ...args: unknown[]) =>
    emit('warn', scope, message, ...args),
  error: (scope: string, message: string, ...args: unknown[]) =>
    emit('error', scope, message, ...args),
};

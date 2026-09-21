import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLogger,
  formatLogLine,
  formatMetaValue,
  parseLogLevel,
  type LogLevel,
} from '../server/src/logger.ts';

describe('parseLogLevel', () => {
  it('认识四个级别，大小写不敏感', () => {
    assert.equal(parseLogLevel('debug'), 'debug');
    assert.equal(parseLogLevel('INFO'), 'info');
    assert.equal(parseLogLevel(' Warn '), 'warn');
    assert.equal(parseLogLevel('error'), 'error');
  });

  it('空值和非法值回落', () => {
    assert.equal(parseLogLevel(undefined), 'info');
    assert.equal(parseLogLevel(''), 'info');
    assert.equal(parseLogLevel('verbose'), 'info');
    assert.equal(parseLogLevel('垃圾', 'warn'), 'warn', '自定义回落值');
  });
});

describe('formatLogLine', () => {
  const entry = {
    time: '2025-01-02T03:04:05.678Z',
    level: 'info' as LogLevel,
    scope: 'track',
    message: '伴奏入库',
  };

  it('一行包含时间、级别、作用域、消息', () => {
    const line = formatLogLine(entry);
    // INFO 补到 5 字符后再接一个分隔空格，所以是 "INFO  [track]"
    assert.match(line, /^2025-01-02T03:04:05\.678Z INFO {2}\[track\] 伴奏入库$/);
  });

  it('级别列对齐（DEBUG/INFO/WARN/ERROR 都是 5 字符）', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const line = formatLogLine({ ...entry, level });
      assert.match(line, new RegExp(`^\\S+ ${level.toUpperCase()} +\\[track\\]`));
    }
  });

  it('meta 渲染成 key=value，含空白的字符串加引号', () => {
    const line = formatLogLine({
      ...entry,
      meta: { id: 'abc', title: '周杰伦 晴天', durationSec: 215.5, ready: true, missing: null },
    });
    assert.match(line, /id=abc/);
    assert.match(line, /title="周杰伦 晴天"/);
    assert.match(line, /durationSec=215\.5/);
    assert.match(line, /ready=true/);
    assert.match(line, /missing=null/);
  });

  it('Error 渲染成 Name: message', () => {
    const line = formatLogLine({ ...entry, level: 'error', meta: { error: new Error('炸了') } });
    assert.match(line, /error=Error: 炸了/);
  });

  it('debug 级别给 Error 附上首个栈帧', () => {
    const line = formatLogLine({ ...entry, level: 'debug', meta: { error: new Error('炸了') } });
    assert.match(line, /error=Error: 炸了 \(at /);
  });

  it('嵌套对象走 JSON', () => {
    const line = formatLogLine({ ...entry, meta: { settings: { a: 1, b: 'x' } } });
    assert.match(line, /settings=\{"a":1,"b":"x"\}/);
  });

  it('超长 meta 值被截断', () => {
    const line = formatLogLine({ ...entry, meta: { blob: 'x'.repeat(1000) } });
    assert.ok(line.includes('blob=' + 'x'.repeat(300) + '…'));
    assert.ok(line.length < 500, `行仍然要短，实际 ${line.length}`);
  });

  it('undefined 的 meta 键被跳过', () => {
    const line = formatLogLine({ ...entry, meta: { keep: 1, drop: undefined } });
    assert.match(line, /keep=1/);
    assert.doesNotMatch(line, /drop/);
  });
});

describe('formatMetaValue', () => {
  it('循环引用不炸', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(typeof formatMetaValue(cyclic), 'string');
  });

  it('含空白才加引号', () => {
    assert.equal(formatMetaValue('abc'), 'abc');
    assert.equal(formatMetaValue('a b'), '"a b"');
  });
});

describe('createLogger', () => {
  const fixedNow = () => new Date('2025-01-02T03:04:05.678Z');

  it('低于阈值的级别被完全过滤', () => {
    const lines: { line: string; level: LogLevel }[] = [];
    const log = createLogger('t', {
      level: 'warn',
      now: fixedNow,
      sink: (line, level) => lines.push({ line, level }),
    });

    log.debug('看不见');
    log.info('也看不见');
    log.warn('看得见');
    log.error('更看得见');

    assert.equal(lines.length, 2);
    assert.match(lines[0]!.line, /WARN {2}\[t\] 看得见/);
    assert.equal(lines[0]!.level, 'warn');
    assert.match(lines[1]!.line, /ERROR \[t\] 更看得见/);
    assert.equal(lines[1]!.level, 'error');
  });

  it('时间戳走注入的时钟', () => {
    const lines: string[] = [];
    const log = createLogger('t', { level: 'debug', now: fixedNow, sink: (line) => lines.push(line) });
    log.info('hello');
    assert.match(lines[0]!, /^2025-01-02T03:04:05\.678Z/);
  });

  it('不传 level 时读 LOG_LEVEL 环境变量', () => {
    const previous = process.env.LOG_LEVEL;
    const lines: string[] = [];
    try {
      process.env.LOG_LEVEL = 'error';
      const log = createLogger('t', { now: fixedNow, sink: (line) => lines.push(line) });
      log.info('被过滤');
      log.error('通过');
      assert.equal(lines.length, 1);
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  it('child 拼接作用域并继承配置', () => {
    const lines: string[] = [];
    const log = createLogger('job', { level: 'debug', now: fixedNow, sink: (line) => lines.push(line) });
    log.child('transcode').info('开始');
    assert.match(lines[0]!, /\[job:transcode\] 开始/);
  });

  it('默认 sink 把 error 写 stderr、info 写 stdout', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      stdout.push(chunk);
      return true;
    };
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      stderr.push(chunk);
      return true;
    };
    try {
      const log = createLogger('sink', { level: 'debug', now: fixedNow });
      log.info('去 stdout');
      log.error('去 stderr');
    } finally {
      (process.stdout as unknown as { write: typeof originalOut }).write = originalOut;
      (process.stderr as unknown as { write: typeof originalErr }).write = originalErr;
    }

    assert.equal(stdout.join('').includes('去 stdout'), true);
    assert.equal(stdout.join('').includes('去 stderr'), false);
    assert.equal(stderr.join('').includes('去 stderr'), true);
  });
});

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ACCESS_TOKEN } from './config.ts';
import { createLogger } from './logger.ts';
import { fail } from './httpError.ts';

/**
 * 可选的局域网访问令牌闸门。
 *
 * 设计约束（都是为了「默认行为零变化」）：
 *
 *  1. **ACCESS_TOKEN 没配 = 这个中间件完全透明**，一个字节的行为都不改；
 *  2. **回环地址永远放行** —— 桌面用户开 http://127.0.0.1:8787 是本项目
 *     最主要的用法，不能为了防局域网让别人在本机反复输令牌；
 *  3. 令牌走 header `x-access-token` 或 query `?token=`。后者是必须的：
 *     `<audio src>` / `<video src>` / `<img src>` 带不了 header；
 *  4. 比较走 SHA-256 摘要 + timingSafeEqual：既避免逐字符比较的长度侧信道，
 *     也避开「两个字符串长度不同时 timingSafeEqual 直接抛错」的坑。
 *
 * 不信任 X-Forwarded-For：单机部署没有反代，信它等于把准入判断交给客户端。
 */

const log = createLogger('auth');

/** 401 的机器可读码：前端据此弹「输入访问令牌」，而不是当成普通错误 */
export const TOKEN_REQUIRED_CODE = 'token_required';

/** 回环地址（桌面本机）：127.0.0.0/8 与 ::1，含 IPv4-mapped 的 ::ffff:127.x */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const bare = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.');
}

/** 恒定时间比较（比对摘要，长度必然一致） */
function tokenMatches(provided: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(ACCESS_TOKEN, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function providedToken(req: Request): string | null {
  const header = req.get('x-access-token');
  if (header && header.trim()) return header.trim();
  const query = req.query.token;
  if (typeof query === 'string' && query.trim()) return query.trim();
  return null;
}

export function createTokenGate(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!ACCESS_TOKEN) return next();
    if (isLoopbackAddress(req.socket.remoteAddress)) return next();

    const provided = providedToken(req);
    if (provided && tokenMatches(provided)) return next();

    log.debug('拒绝无令牌请求', { path: req.path, from: req.socket.remoteAddress });
    fail(res, 401, 'token_required');
  };
}

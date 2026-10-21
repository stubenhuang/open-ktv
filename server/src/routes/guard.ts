//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import type { Request, RequestHandler, Response } from 'express';
import { fail, type ApiErrorCode } from '../httpError.ts';

export interface WithRecordOptions<T> {
  /** 按 :id 取记录，找不到返回 undefined */
  load: (id: string) => T | undefined;
  /** 找不到时的机器可读码（前端按它查本地化文案） */
  notFound: ApiErrorCode;
  handler: (req: Request, res: Response, record: T) => void;
}

/**
 * 把「按 :id 取记录 → 找不到就 404 → 交给业务处理」收口成一处。
 *
 * tracks / works 的每个带 id 的处理器原先都各写一遍这段，
 * 顺便把 404 文案硬编码了好几份。现在只传一个错误码，句子由前端说。
 */
export function withRecord<T>(options: WithRecordOptions<T>): RequestHandler {
  return (req, res) => {
    const rawId = req.params.id;
    // 通配路由下 params 可能给出数组，这里只取第一段
    const id = Array.isArray(rawId) ? (rawId[0] ?? '') : rawId;
    const record = options.load(id);
    if (!record) {
      fail(res, 404, options.notFound);
      return;
    }
    options.handler(req, res, record);
  };
}

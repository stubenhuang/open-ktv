//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response } from 'express';
import multer from 'multer';
import { createLogger } from './logger.ts';
import { TMP_DIR } from './paths.ts';
import { fail, readHttpError, type ApiErrorCode } from './httpError.ts';

const log = createLogger('upload');

export interface UploadEndpointOptions {
  /** 表单字段名 */
  field: string;
  /** 单文件大小上限（字节） */
  maxBytes: number;
  /** 临时文件名前缀，便于排障 */
  tmpPrefix: string;
  /** 超过大小上限时的机器可读码（413），params.limit 带上「1 GB」这样的可读值 */
  sizeLimitCode: ApiErrorCode;
  /** 没有收到文件时的机器可读码（400） */
  missingFileCode: ApiErrorCode;
  /** 其他 multer 错误 / 业务异常的兜底码 */
  errorCode: ApiErrorCode;
  /** 业务处理抛错时的日志文案 */
  logMessage: string;
  /** 业务处理；此时文件已落在 TMP_DIR，处理完（无论成败）都会被清理 */
  handle: (req: Request, res: Response, file: Express.Multer.File) => Promise<void>;
}

/** 大小上限的可读值（GB 一位小数）—— 给错误 params 用 */
export function sizeLimitGb(maxBytes: number): string {
  return `${Math.round((maxBytes / 1024 / 1024 / 1024) * 10) / 10} GB`;
}

/**
 * 清掉 multer 落在 tmp/ 的临时文件。
 * 业务成功后文件已被 rename 走，force 删除对不存在的路径是 no-op；
 * 清理失败只记日志，不能让已经成功的上传变成 400。
 */
async function discardUpload(file?: Express.Multer.File): Promise<void> {
  if (!file) return;
  try {
    await fs.promises.rm(file.path, { force: true });
  } catch (error) {
    log.warn('清理临时文件失败', { path: file.path, error });
  }
}

/**
 * 收一个文件并交给业务处理，把 multer 的样板收口在一处：
 * 临时目录 + 随机文件名、单文件大小上限、字段缺失、临时文件清理、业务异常 → 400。
 * 单机自用不需要多文件上传，所以只支持 single(field)。
 */
export function uploadEndpoint(options: UploadEndpointOptions): (req: Request, res: Response) => void {
  const receive = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, TMP_DIR),
      // 先用随机名收进临时目录，探测通过后再重命名成 <id><ext>
      filename: (_req, _file, callback) => callback(null, `${options.tmpPrefix}-${randomUUID()}`),
    }),
    limits: { fileSize: options.maxBytes, files: 1 },
  }).single(options.field);

  return (req, res) => {
    receive(req, res, (uploadError: unknown) => {
      if (uploadError) {
        // 这一层是同步回调，清理只能并行做掉
        void discardUpload(req.file);
        const err = uploadError as { code?: string; message?: string };
        if (err.code === 'LIMIT_FILE_SIZE') {
          fail(res, 413, options.sizeLimitCode, { limit: sizeLimitGb(options.maxBytes) });
          return;
        }
        fail(res, 400, options.errorCode, { reason: err.message ?? 'unknown error' });
        return;
      }

      const file = req.file;
      if (!file) {
        fail(res, 400, options.missingFileCode);
        return;
      }

      void (async () => {
        try {
          await options.handle(req, res, file);
        } catch (error) {
          // 先把临时文件清干净再回错，避免 tmp 里留下一份半成品
          await discardUpload(file);
          log.error(options.logMessage, { error });
          // 业务层抛 HttpError（带 status / code / params）时原样回给客户端；
          // 普通异常按 options.errorCode 兜底 —— 上传路径上的失败基本都是
          // 「你给的文件有问题」
          const { status, code, params } = readHttpError(error, options.errorCode, 400);
          fail(res, status, code, params);
          return;
        }
        await discardUpload(file);
      })();
    });
  };
}

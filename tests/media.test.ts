import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { after, before, describe, it } from 'node:test';
import { contentTypeFor, sendMedia } from '../server/src/media.ts';
import { cleanupDir, makeTempDir } from './helpers.ts';

let workDir = '';
let mp3 = '';
let wav = '';

before(async () => {
  workDir = await makeTempDir('media');
  mp3 = path.join(workDir, 'a.mp3');
  wav = path.join(workDir, 'b.wav');
  fs.writeFileSync(mp3, 'ID3 fake mp3');
  fs.writeFileSync(wav, 'RIFF fake wav');
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

/** 最小假 Response：只实现 sendMedia 用到的几个方法，并记录调用 */
function fakeResponse() {
  const state = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    ended: false,
    sendFile: null as { path: string; callback?: (error?: unknown) => void } | null,
  };
  const res = {
    headersSent: false,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    type(value: string) {
      state.headers['content-type'] = value;
      return res;
    },
    setHeader(key: string, value: string) {
      state.headers[key.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
    end() {
      state.ended = true;
      return res;
    },
    sendFile(filePath: string, callback?: (error?: unknown) => void) {
      state.sendFile = { path: filePath, callback };
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

describe('contentTypeFor', () => {
  it('常见音频视频格式都有映射', () => {
    assert.equal(contentTypeFor('a.mp3'), 'audio/mpeg');
    assert.equal(contentTypeFor('a.wav'), 'audio/wav');
    assert.equal(contentTypeFor('a.flac'), 'audio/flac');
    assert.equal(contentTypeFor('a.m4a'), 'audio/mp4');
    assert.equal(contentTypeFor('a.ogg'), 'audio/ogg');
    assert.equal(contentTypeFor('a.mp4'), 'video/mp4');
    assert.equal(contentTypeFor('a.webm'), 'video/webm');
  });

  it('扩展名大小写不敏感，未知类型给 octet-stream', () => {
    assert.equal(contentTypeFor('A.MP3'), 'audio/mpeg');
    assert.equal(contentTypeFor('a.xyz'), 'application/octet-stream');
    assert.equal(contentTypeFor('noext'), 'application/octet-stream');
  });
});

describe('sendMedia', () => {
  it('文件不存在时 404 JSON，不发文件', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, path.join(workDir, 'missing.mp3'));

    assert.equal(state.statusCode, 404);
    assert.deepEqual(state.body, { error: '文件不存在或已被删除' });
    assert.equal(state.sendFile, null);
  });

  it('存在时设置类型 / Range / 禁缓存头', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, mp3);

    assert.equal(state.statusCode, 200);
    assert.equal(state.headers['content-type'], 'audio/mpeg');
    assert.equal(state.headers['accept-ranges'], 'bytes');
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.equal(state.headers['content-disposition'], undefined);
    assert.equal(state.sendFile?.path, mp3);
  });

  it('downloadName 时带 Content-Disposition（ASCII 兜底 + UTF-8 双写）', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, wav, '我的歌 名.wav');

    const disposition = state.headers['content-disposition']!;
    assert.match(disposition, /^attachment; /);
    // 「我的歌 名.wav」：4 个非 ASCII 字符换下划线，空格保留
    assert.match(disposition, /filename="___ _\.wav"/, '非 ASCII 字符替换成下划线');
    assert.match(disposition, /filename\*=UTF-8''[^;]+/, '同时给 UTF-8 编码版本');
  });

  it('客户端中断（EPIPE/ECONNABORTED）不当成错误', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, mp3);
    const abortError = Object.assign(new Error('aborted'), { code: 'EPIPE' });
    state.sendFile!.callback!(abortError);

    assert.equal(state.ended, true);
    assert.equal(state.statusCode, 200, '已经发出的流不改状态码');
  });

  it('其他读取错误 → 500 JSON', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, mp3);
    state.sendFile!.callback!(new Error('磁盘炸了'));

    assert.equal(state.statusCode, 500);
    assert.deepEqual(state.body, { error: '读取文件失败：磁盘炸了' });
  });

  it('没有错误时什么都不做', () => {
    const { res, state } = fakeResponse();
    sendMedia(res, mp3);
    state.sendFile!.callback!();
    assert.equal(state.ended, false);
    assert.equal(state.statusCode, 200);
  });
});

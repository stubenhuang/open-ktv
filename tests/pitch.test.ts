//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  describePitch,
  pitchActive,
  semitonesToRatio,
} from '../shared/mix.ts';
import { PITCH_LIMITS } from '../shared/types.ts';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * 升降调（伴奏移调）。
 *
 * 纯函数部分钉住「半音 ↔ 频率比 ↔ ffmpeg 参数」的换算；集成部分**实跑
 * rubberband** 验证移调真的改了音高、且**没有改时长**（时长不变是这套设计
 * 的前提：歌词时间轴、自动对齐、分段重录全都建立在它上面）。
 */

/** 数一段区间的过零次数：440Hz 与 220/880Hz 的稳定判别器 */
function zeroCrossings(samples: Float32Array, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.round(fromSec * 48000));
  const to = Math.min(samples.length, Math.round(toSec * 48000));
  let count = 0;
  for (let i = from + 1; i < to; i += 1) {
    if (samples[i - 1]! <= 0 !== samples[i]! <= 0) count += 1;
  }
  return count;
}

let dataDir = '';
let workDir = '';
let helpers: typeof import('./helpers.ts');
let pitch: typeof import('../server/src/pitch.ts');
let dto: typeof import('../server/src/dto.ts');
let db: typeof import('../server/src/db.ts');
/** 440Hz 正弦「伴奏」（移调前的基准） */
let source = '';

before(async () => {
  dataDir = await createIsolatedDataDir('pitch');
  workDir = path.join(dataDir, 'fixtures');
  helpers = await import('./helpers.ts');
  await (await import('node:fs')).promises.mkdir(workDir, { recursive: true });

  source = path.join(workDir, 'accomp.wav');
  await helpers.ffmpegOk(helpers.sineArgs(source, 3, 440, ['-c:a', 'pcm_s16le']));

  pitch = await import('../server/src/pitch.ts');
  dto = await import('../server/src/dto.ts');
  db = await import('../server/src/db.ts');
  db.initDb();
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

describe('半音换算', () => {
  it('0 = 原调，±12 = 一个八度', () => {
    assert.equal(semitonesToRatio(0), 1);
    assert.equal(semitonesToRatio(12), 2);
    assert.equal(semitonesToRatio(-12), 0.5);
  });

  it('非整数半音按 2^(n/12) 精确换算', () => {
    assert.ok(Math.abs(semitonesToRatio(7) - Math.pow(2, 7 / 12)) < 1e-12);
    assert.ok(Math.abs(semitonesToRatio(-5) - Math.pow(2, -5 / 12)) < 1e-12);
  });

  it('脏值按 0 处理（NaN / Infinity / 字符串）', () => {
    assert.equal(semitonesToRatio(Number.NaN), 1);
    assert.equal(semitonesToRatio(Number.POSITIVE_INFINITY), 1);
  });

  it('pitchActive 按四舍五入后的半音数判断；describePitch 给人看', () => {
    assert.equal(pitchActive(0), false);
    // 不足半音的一半 → 还是原调（滑块一步就是 1 半音，这里防的是脏数据）
    assert.equal(pitchActive(0.2), false);
    assert.equal(pitchActive(0.4), false);
    assert.equal(pitchActive(0.6), true);
    assert.equal(describePitch(0), '原调');
    assert.equal(describePitch(3), '+3 半音');
    assert.equal(describePitch(-2), '-2 半音');
  });
});

describe('ffmpeg 参数构造', () => {
  it('滤镜串带上正确的频率比与三个必要选项', () => {
    const filter = pitch.pitchShiftFilter(-3);
    assert.match(filter, /^rubberband=/);
    assert.ok(filter.includes(`pitch=${semitonesToRatio(-3).toFixed(6)}`));
    // tempo=1：移调不改速度；formant=preserved：不移共振峰；pitchq=quality：这份文件要被反复听
    assert.ok(filter.includes('tempo=1'));
    assert.ok(filter.includes('formant=preserved'));
    assert.ok(filter.includes('pitchq=quality'));
  });

  it('音频伴奏：-vn + mp3 规格', () => {
    const args = pitch.buildPitchShiftArgs({
      sourcePath: '/in.flac',
      outputPath: '/out.mp3',
      semitones: 5,
      kind: 'audio',
    });
    assert.equal(args[0], '-y');
    assert.equal(args[4], '/in.flac', '源文件要原样传进去');
    assert.equal(args[args.length - 1], '/out.mp3');
    assert.ok(args.includes('-vn'), '只出音频');
    const af = args.indexOf('-af');
    assert.ok(af > 0);
    assert.match(args[af + 1]!, /rubberband=/);
    // 与代理/成品同一套 mp3 规格（192k 48k 立体声）
    assert.ok(args.includes('libmp3lame'));
    assert.ok(args.includes('192k'));
    assert.ok(args.includes('48000'));
    assert.ok(args.includes('2'));
  });

  it('视频伴奏：画面直接拷贝，只重编码音频', () => {
    const args = pitch.buildPitchShiftArgs({
      sourcePath: '/in.mkv',
      outputPath: '/out.mp4',
      semitones: -7,
      kind: 'video',
    });
    assert.equal(args[args.indexOf('-c:v') + 1], 'copy', '移调不该重编码画面');
    assert.ok(!args.includes('-vn'));
    assert.match(args[args.indexOf('-af') + 1]!, /rubberband=/);
    // 两条 -map：画面 + 音频
    assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
    assert.equal(args[args.indexOf('-map') + 3], '0:a:0');
  });

  it('移调文件落在 proxies 下，扩展名按伴奏类型', () => {
    assert.equal(
      pitch.pitchPathFor('abc', 'audio'),
      path.join(dataDir, 'proxies', 'abc.pitch.mp3'),
    );
    assert.equal(
      pitch.pitchPathFor('abc', 'video'),
      path.join(dataDir, 'proxies', 'abc.pitch.mp4'),
    );
  });
});

describe('半音数消毒', () => {
  it('夹到 ±12 并取整；非数字回落上一个有效值', () => {
    assert.equal(pitch.normalizeSemitones(3, 0), 3);
    assert.equal(pitch.normalizeSemitones(12.4, 0), 12);
    assert.equal(pitch.normalizeSemitones(-99, 0), PITCH_LIMITS.semitones.min);
    assert.equal(pitch.normalizeSemitones(99, 0), PITCH_LIMITS.semitones.max);
    // 解析不出数字 → 用当前值，绝不静默变成 0（= 原调）
    assert.equal(pitch.normalizeSemitones('abc', -4), -4);
    assert.equal(pitch.normalizeSemitones(null, 7), 7);
    assert.equal(pitch.normalizeSemitones(undefined, 7), 7);
    assert.equal(pitch.normalizeSemitones('', 7), 7);
  });
});

describe('playableFileFor / mixAccompFileFor：谁该播、谁该混', () => {
  const base = {
    id: 't',
    title: '歌',
    artist: null,
    kind: 'audio' as const,
    originalName: 'a.flac',
    originalPath: '/orig.flac',
    // 原始文件浏览器播不了 → 有一份 mp3 代理；混音照旧用母带
    playablePath: '/proxy.mp3',
    proxyKind: 'audio' as const,
    mime: null,
    size: 1,
    duration: 10,
    status: 'ready' as const,
    error: null,
    createdAt: 0,
    lyrics: null,
    lyricsOffsetMs: 0,
    source: 'upload' as const,
    libraryRef: null,
    pitchError: null,
  };

  it('原调：播代理、混母带（与升降调上线之前逐字节一致）', () => {
    const track = { ...base, pitchSemitones: 0, pitchPath: null };
    assert.equal(pitch.playableFileFor(track), '/proxy.mp3');
    assert.equal(pitch.mixAccompFileFor(track), '/orig.flac');
  });

  it('非原调且移调伴奏已生成：两处都用移调那份', () => {
    const track = { ...base, pitchSemitones: 4, pitchPath: '/pitch.mp3' };
    assert.equal(pitch.playableFileFor(track), '/pitch.mp3');
    assert.equal(pitch.mixAccompFileFor(track), '/pitch.mp3');
  });

  it('非原调但还没生成好（生成中/失败）：各自回落，播放与混音都不中断', () => {
    const track = { ...base, pitchSemitones: 4, pitchPath: null };
    assert.equal(pitch.playableFileFor(track), '/proxy.mp3');
    assert.equal(pitch.mixAccompFileFor(track), '/orig.flac');
  });

  it('库里的调是 0 却留着旧路径（脏数据）→ 仍按原调', () => {
    const track = { ...base, pitchSemitones: 0, pitchPath: '/pitch.mp3' };
    assert.equal(pitch.playableFileFor(track), '/proxy.mp3');
    assert.equal(pitch.mixAccompFileFor(track), '/orig.flac');
  });
});

describe('effectivePitchSemitones：此刻实际是哪个调', () => {
  const base = {
    id: 't',
    title: '歌',
    artist: null,
    kind: 'audio' as const,
    originalName: 'a.flac',
    originalPath: '/orig.flac',
    playablePath: '/proxy.mp3',
    proxyKind: 'audio' as const,
    mime: null,
    size: 1,
    duration: 10,
    status: 'ready' as const,
    error: null,
    createdAt: 0,
    lyrics: null,
    lyricsOffsetMs: 0,
    source: 'upload' as const,
    libraryRef: null,
    pitchError: null,
  };

  it('原调 → 0', () => {
    assert.equal(pitch.effectivePitchSemitones({ ...base, pitchSemitones: 0, pitchPath: null }), 0);
  });

  it('移调文件在位 → 用户选的那个调', () => {
    assert.equal(
      pitch.effectivePitchSemitones({ ...base, pitchSemitones: -7, pitchPath: '/p.mp3' }),
      -7,
    );
  });

  // 这条是作品库徽章的依据：选了调但文件还没生成好（或生成失败），
  // 播放和混音用的其实还是原调，徽章必须据实写 0，不能跟着用户选的数字说大话
  it('选了调但文件没生成好（生成中 / 失败）→ 0，因为实际听到的就是原调', () => {
    assert.equal(pitch.effectivePitchSemitones({ ...base, pitchSemitones: 4, pitchPath: null }), 0);
    assert.equal(
      pitch.effectivePitchSemitones({ ...base, pitchSemitones: 4, pitchPath: null, pitchError: '炸了' }),
      0,
    );
  });

  it('和 playableFileFor / mixAccompFileFor 判据一致（说的是同一个调）', () => {
    const generating = { ...base, pitchSemitones: 4, pitchPath: null };
    assert.equal(pitch.effectivePitchSemitones(generating), 0);
    assert.equal(pitch.playableFileFor(generating), generating.playablePath, '回落 = 原调');

    const ready = { ...base, pitchSemitones: 4, pitchPath: '/p.mp3' };
    assert.equal(pitch.effectivePitchSemitones(ready), 4);
    assert.equal(pitch.playableFileFor(ready), '/p.mp3', '移调文件 = 新调');
  });
});

describe('移调状态（dto）', () => {
  const base = {
    id: 't',
    title: '歌',
    artist: null,
    kind: 'audio' as const,
    originalName: 'a.mp3',
    originalPath: '/orig.mp3',
    playablePath: '/proxy.mp3',
    proxyKind: 'none' as const,
    mime: null,
    size: 1,
    duration: 10,
    status: 'ready' as const,
    error: null,
    createdAt: 0,
    lyrics: null,
    lyricsOffsetMs: 0,
    source: 'upload' as const,
    libraryRef: null,
    pitchError: null,
  };

  it('原调永远是 ready', () => {
    assert.equal(dto.pitchStatusOf({ ...base, pitchSemitones: 0, pitchPath: null }), 'ready');
  });

  it('移调文件落库即 ready', () => {
    assert.equal(
      dto.pitchStatusOf({ ...base, pitchSemitones: -6, pitchPath: '/pitch.mp3' }),
      'ready',
    );
  });

  it('任务在跑是 processing，任务不在又没文件是 failed', () => {
    const queued = { ...base, pitchSemitones: 2, pitchPath: null };
    // 不排任务时：没有文件 → failed（播放回落到原调，用户重设即可）
    assert.equal(dto.pitchStatusOf(queued), 'failed');

    pitch.startPitchShift({
      trackId: 't',
      sourcePath: source,
      semitones: 2,
      kind: 'audio',
      durationSec: 3,
    });
    assert.equal(dto.pitchStatusOf(queued), 'processing', '入队后应为 processing');
  });
});

describe('真实 ffmpeg：移调改音高、不改时长', () => {
  it('+12 半音 → 频率翻倍；−12 半音 → 频率减半；时长都不变', async () => {
    const up = path.join(workDir, 'up12.wav');
    const down = path.join(workDir, 'down12.wav');

    for (const [output, semitones] of [
      [up, 12],
      [down, -12],
    ] as const) {
      await helpers.ffmpegOk(
        pitch.buildPitchShiftArgs({ sourcePath: source, outputPath: output, semitones, kind: 'audio' }),
      );
      const decoded = await helpers.decodeToFloat32(output);
      const duration = decoded.samples.length / decoded.sampleRate;
      assert.ok(Math.abs(duration - 3) < 0.05, `时长被改了：${duration.toFixed(3)}s`);
      // 跳过开头 0.3s（rubberband 的起播瞬态），数 2 秒的过零
      const crossings = zeroCrossings(decoded.samples, 0.3, 2.3);
      const hz = crossings / 2 / 2;
      const expected = 440 * semitonesToRatio(semitones);
      assert.ok(
        Math.abs(hz - expected) < 12,
        `${semitones > 0 ? '+' : ''}${semitones} 半音后应约 ${expected}Hz，实测 ${hz.toFixed(1)}Hz`,
      );
    }
  });

  it('排一次任务：跑完之后路径落库、文件在位、音高真的变了', async () => {
    const jobs = await import('../server/src/jobs.ts');
    db.insertTrack({
      id: 'job-t',
      title: '歌',
      artist: null,
      kind: 'audio',
      originalName: 'accomp.wav',
      originalPath: source,
      playablePath: source,
      proxyKind: 'none',
      mime: null,
      size: 1,
      duration: 3,
      status: 'ready',
      error: null,
    });
    // 真实流程里这一步是 PATCH 路由做的：先落「用户选了 +12」，再排任务
    db.updateTrack('job-t', { pitchSemitones: 12 });

    pitch.startPitchShift({
      trackId: 'job-t',
      sourcePath: source,
      semitones: 12,
      kind: 'audio',
      durationSec: 3,
    });    // 等队列跑干（单并发队列，这里只有这一个任务）
    await jobs.whenQueueIdle();

    const record = db.getTrack('job-t')!;
    assert.equal(record.pitchError, null, `移调不该失败：${record.pitchError}`);
    assert.equal(record.pitchPath, pitch.pitchPathFor('job-t', 'audio'));
    assert.ok(fs.existsSync(record.pitchPath!), '移调文件要落在盘上');
    // 同时只留一份：.part 临时名必须已经被 rename 掉
    assert.equal(fs.existsSync(`${record.pitchPath}.part`), false);

    const decoded = await helpers.decodeToFloat32(record.pitchPath!);
    const hz = zeroCrossings(decoded.samples, 0.3, 2.3) / 2 / 2;
    assert.ok(Math.abs(hz - 880) < 12, `移调后应约 880Hz，实测 ${hz.toFixed(1)}Hz`);
    // 播放/混音都要解析到移调文件
    assert.equal(pitch.playableFileFor(record), record.pitchPath);
    assert.equal(pitch.mixAccompFileFor(record), record.pitchPath);
  });

  it('任务跑完时用户已经改了调：旧产物被丢掉，不落到最终路径', async () => {
    const jobs = await import('../server/src/jobs.ts');
    db.insertTrack({
      id: 'stale-t',
      title: '歌',
      artist: null,
      kind: 'audio',
      originalName: 'accomp.wav',
      originalPath: source,
      playablePath: source,
      proxyKind: 'none',
      mime: null,
      size: 1,
      duration: 3,
      status: 'ready',
      error: null,
    });
    db.updateTrack('stale-t', { pitchSemitones: 12 });

    pitch.startPitchShift({
      trackId: 'stale-t',
      sourcePath: source,
      semitones: 12,
      kind: 'audio',
      durationSec: 3,
    });
    // 趁任务还在队列里（或刚跑完）把调改掉：模拟「拖过去又拖回来」
    db.updateTrack('stale-t', { pitchSemitones: -12, pitchPath: null, pitchError: null });
    await jobs.whenQueueIdle();

    const record = db.getTrack('stale-t')!;
    assert.equal(record.pitchSemitones, -12);
    assert.equal(record.pitchPath, null, '旧调的产物不该被当成新调的用');
    assert.equal(fs.existsSync(pitch.pitchPathFor('stale-t', 'audio')), false, '产物要丢掉');
    assert.equal(pitch.playableFileFor(record), record.playablePath, '播放回落到代理');
    assert.equal(pitch.mixAccompFileFor(record), record.originalPath, '混音回落到母带');
  });
});

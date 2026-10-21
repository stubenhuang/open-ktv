//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

/**
 * 伴奏升降调（移调）。
 *
 * ## 为什么是「生成一份移调伴奏」而不是在混音时移调
 *
 * 升降调要解决的是「这歌的调我唱不上去」。那就必须**在唱之前就听到新调** ——
 * 事后在混音里移调伴奏，人声还是按原调唱的，两者永远对不上。所以这里把移调
 * 提前到「选调」这一步：服务端用 ffmpeg 的 rubberband 从原始文件派生一份
 * 移调伴奏，之后三处用的都是它：
 *
 *   · 演唱页的 `<audio>`/`<video>`（`/api/media/track/:id` 解析到它）
 *   · 实时试听（预览引擎拉的是同一个地址）
 *   · 成品混音（mixJob 的伴奏输入）
 *
 * 于是「耳机里听到的」和「成品 MP3 里的」永远是同一份音频，人声是干声、
 * 天然就对在新调上。代价是选调后要等几秒生成（有状态提示），以及磁盘上多
 * 一份文件（换调/回原调时立刻删掉旧的，同时只留一份）。
 *
 * ## 为什么用 rubberband
 *
 * 它是相位声码器，移调**不改时长** —— 这首歌多长，移调后还是多长，
 * 歌词时间轴、自动对齐、分段重录全部不用动。`asetrate` 那类「改采样率」
 * 的做法会连速度一起改，直接出局。
 *
 * ## 为什么要有能力探测
 *
 * rubberband 是 ffmpeg 的编译期开关（`--enable-librubberband`），不是所有
 * 发行版都带。缺了就禁用升降调并说清楚原因（见 ffmpegCapabilities.ts），
 * 绝不能等到用户点保存才抛一句 "No such filter"。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TrackKind } from '../../shared/types.ts';
import { PITCH_LIMITS } from '../../shared/types.ts';
import { clampInt } from '../../shared/numbers.ts';
import { pitchActive, semitonesToRatio } from '../../shared/mix.ts';
import { AUDIO, JOB_TIMEOUT_MS, TRANSCODE } from './config.ts';
import type { TrackRecord } from './db.ts';
import { getTrack, updateTrack } from './db.ts';
import { pitchKey } from './dto.ts';
import { MP3_OUTPUT_ARGS, PROGRESS_OUTPUT_ARGS, runFfmpeg } from './ffmpeg.ts';
import { enqueue } from './jobs.ts';
import { createLogger } from './logger.ts';
import { PROXIES_DIR } from './paths.ts';

const log = createLogger('pitch');

/**
 * 移调伴奏的落点：`data/proxies/<id>.pitch.mp3|mp4`。
 *
 * 与转码代理同目录（都是「派生出来给浏览器播的文件」），但名字带 `.pitch.`
 * —— 删伴奏时那两条兜底 rm 是按 `<id>.mp3` / `<id>.mp4` 拼的，不会误伤，
 * 移调文件由这个模块自己负责删。
 */
export function pitchPathFor(trackId: string, kind: TrackKind): string {
  return path.join(PROXIES_DIR, `${trackId}.pitch.${kind === 'video' ? 'mp4' : 'mp3'}`);
}

/**
 * rubberband 滤镜串。
 *
 * 几个选项各有理由：
 *  · `pitch` = 半音换算出来的频率比，`tempo=1` 锁住速度（移调不改时长）；
 *  · `formant=preserved` 保住共振峰 —— 不移的话整首歌会往「花栗鼠/巨人」方向跑，
 *    伴奏里的吉他、人声和声全都变味；
 *  · `pitchq=quality`：这份文件是唯一被播放/混音的源，多花点生成时间换音质
 *    是划算的（一首歌通常几秒到十几秒）。
 */
export function pitchShiftFilter(semitones: number): string {
  const ratio = semitonesToRatio(semitones).toFixed(6);
  return `rubberband=pitch=${ratio}:tempo=1:formant=preserved:pitchq=quality`;
}

export interface PitchShiftArgsInput {
  sourcePath: string;
  outputPath: string;
  semitones: number;
  kind: TrackKind;
}

/**
 * 移调一次 ffmpeg 的完整参数。
 *
 * 源用**原始文件**（不是转码代理）：代理可能已经是有损 mp3，再从它转一手
 * 是白损失一代音质。视频伴奏只 `-c:v copy` 拷贝画面，重编码的只有音频。
 *
 * `-f mp3|mp4` 必须显式给：先写 `.part` 再 rename 的过程中文件名是
 * `xxx.pitch.mp3.part`，ffmpeg 靠扩展名推不出格式，会直接报
 * 「Unable to choose an output format」（mix.ts 的预处理参数同款坑）。
 */
export function buildPitchShiftArgs(input: PitchShiftArgsInput): string[] {
  const common = ['-y', '-hide_banner', '-nostdin', '-i', input.sourcePath];

  if (input.kind === 'video') {
    return [
      ...common,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      // 画面原样拷贝：移调只该动音频，重编码一遍视频既慢又白掉一代画质
      '-c:v',
      'copy',
      '-af',
      pitchShiftFilter(input.semitones),
      '-c:a',
      'aac',
      '-b:a',
      TRANSCODE.videoAudioBitrate,
      '-ar',
      String(AUDIO.sampleRate),
      '-ac',
      String(AUDIO.channels),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      ...PROGRESS_OUTPUT_ARGS,
      input.outputPath,
    ];
  }

  return [
    ...common,
    '-vn',
    '-af',
    pitchShiftFilter(input.semitones),
    ...MP3_OUTPUT_ARGS,
    '-f',
    'mp3',
    ...PROGRESS_OUTPUT_ARGS,
    input.outputPath,
  ];
}

/**
 * 移调伴奏（要求了非原调且已落库时才是它，否则 null）。
 *
 * 生成中 / 生成失败 / 回原调 → null，两个消费方各自回落到自己那份文件，
 * 于是播放与混音都不会因为「移调还没好」而断掉。
 */
function pitchedFileFor(track: TrackRecord): string | null {
  return pitchActive(track.pitchSemitones) ? track.pitchPath : null;
}

/**
 * 浏览器该播的那份：移调伴奏 → 转码代理 / 原文件。
 *
 * 播放必须落在浏览器能直接播的文件上（ape / wma 之类只有代理能播），
 * 所以原调时给的是 playablePath。
 */
export function playableFileFor(track: TrackRecord): string {
  return pitchedFileFor(track) ?? track.playablePath;
}

/**
 * 混音该混的那份：移调伴奏 → **原始文件**。
 *
 * 原调时刻意用 originalPath 而不是 playablePath：转码代理是有损 mp3，
 * 从它再混一版是白损失一代音质（母带还在 originals/ 里）。这条口径与
 * 升降调上线之前完全一致 —— 零回归。
 */
export function mixAccompFileFor(track: TrackRecord): string {
  return pitchedFileFor(track) ?? track.originalPath;
}

/**
 * 这份伴奏「此刻实际是哪个调」（半音）；原调 / 还没生成好 / 生成失败 → 0。
 *
 * 与 playableFileFor / mixAccompFileFor 同一套判据（移调文件在位才算数），
 * 所以它说的就是用户耳朵听到的、成品里混的那个调。作品库徽章用它做快照：
 * 移调还在生成中就混音，混进去的其实是原调，徽章得据实写 0，不能跟着
 * 用户选的那个数字说大话。
 */
export function effectivePitchSemitones(track: TrackRecord): number {
  return pitchActive(track.pitchSemitones) && track.pitchPath ? track.pitchSemitones : 0;
}

/** 删伴奏时调用：把移调伴奏一并清掉 */
export function forgetTrackPitch(trackId: string, pitchPath: string | null): void {
  if (!pitchPath) return;
  void fs.promises.rm(pitchPath, { force: true }).catch((error: unknown) => {
    log.warn('清理移调伴奏失败', { trackId, pitchPath, error });
  });
}

/**
 * 排一次移调。任务内部重新读库 —— 保证用的是最新状态（和转码一个套路）。
 *
 * 先写 `<path>.part` 再 rename：中途失败不会留下一个「看起来已生成好」的半截
 * 文件，否则下次播放/混音会把它当成品用。
 *
 * 落库前还要再确认一次「用户现在要的还是这个调吗」。队列是单并发的，拖动滑块
 * 连改几个调就会排进好几个任务，而它们共用同一个输出路径 —— 不确认的话，
 * 先排的那个任务跑完会把**旧调**的文件落到最终路径上，用户听到的就是错的调。
 * 所以：任务跑完 → 重新读库 → 调变了（或伴奏已经没了）就把这份产物丢掉，
 * 让排在后面的新任务去写。
 */
export function startPitchShift(input: {
  trackId: string;
  sourcePath: string;
  semitones: number;
  kind: TrackKind;
  durationSec: number | null;
}): void {
  const { trackId, sourcePath, semitones, kind, durationSec } = input;
  if (!pitchActive(semitones)) return;

  const outputPath = pitchPathFor(trackId, kind);
  const partial = `${outputPath}.part`;

  enqueue(
    pitchKey(trackId),
    async (report) => {
      await fs.promises.rm(partial, { force: true });
      log.debug('伴奏移调', { trackId, semitones, outputPath });
      await runFfmpeg({
        args: buildPitchShiftArgs({ sourcePath, outputPath: partial, semitones, kind }),
        timeoutMs: JOB_TIMEOUT_MS.preProcess,
        totalDurationSec: durationSec,
        onProgress: report,
        label: '伴奏移调',
      });

      const current = getTrack(trackId);
      if (!current || current.pitchSemitones !== semitones) {
        // 用户改了调 / 回原调 / 删了伴奏：这份产物不作数
        await fs.promises.rm(partial, { force: true });
        log.debug('移调产物已丢弃（用户改了他们要的调）', { trackId, semitones });
        return;
      }

      await fs.promises.rename(partial, outputPath);
      // 只有生成成功才把路径写进库：这之前两个解析函数一直回落到各自的默认文件
      updateTrack(trackId, { pitchPath: outputPath, pitchError: null });
      log.info(`伴奏已移调 ${semitones > 0 ? '+' : ''}${semitones} 半音`, {
        trackId,
        outputPath,
      });
    },
    (error) => {
      updateTrack(trackId, { pitchPath: null, pitchError: error.message });
      void fs.promises.rm(partial, { force: true });
    },
  );
}

/**
 * 半音数消毒：非数字回落上一个有效值，其余夹到 ±12 并取整。
 *
 * 和服务端其它参数一个口径（见 shared/numbers.ts 的 clampInt）——
 * 把用户拖出来的 12.4 静默变成 12 可以，把 "abc" 变成 0 不行。
 *
 * `null` / `undefined` / 空串也走回落：它们是「没给值」，不是「要回原调」
 * （clampInt 里 `Number(null)` 恰好是 0，会把一次漏传变成偷偷归零）。
 */
export function normalizeSemitones(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  return clampInt(value, PITCH_LIMITS.semitones.min, PITCH_LIMITS.semitones.max, fallback);
}

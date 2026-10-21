//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { nearestReverbKind, pitchActive } from '../../../shared/mix.ts';
import type { ReverbKind, VocalPreset } from '../../../shared/types.ts';
import { translate } from './catalog.ts';
import { createFormatters } from './format.ts';
import type { Locale } from './types.ts';

/**
 * 共享词汇的本地化出口。
 *
 * `shared/` 里有一批「给人看的摘要」—— `VOCAL_PRESET_LABELS`、`REVERB_LABELS`、
 * `describePitch()`、`describeReverb()`。它们**同时被服务端日志和界面用**，
 * 而服务端不能说人话（见 docs/i18n.md「Server-side errors」），所以：
 *
 *   · 服务端日志继续用 shared/ 的中文版（运维日志的读者就是会中文的部署者）；
 *   · 界面一律走本文件的 `*Label()` 系列，词从文案目录里取。
 *
 * 这些函数都显式接收 `locale`（不读 React context、不读模块级全局），
 * 所以页面、组件、纯函数都能调，也不会在 `shared/` 与 `web/` 之间拉出循环依赖。
 *
 * 对应词表在 `locales/<语言>/audio.ts`：
 *   `audio.preset.<preset>`   —— 十个人声预设
 *   `audio.reverb.kind.<kind>`—— 混响空间轴上的 8 个档位名
 *   `audio.pitch.original`    —— 0 半音时的读数
 */

/** 人声预设名（自然 / Natural…） */
export function presetLabel(locale: Locale, preset: VocalPreset): string {
  return translate(locale, `audio.preset.${preset}`);
}

/** 混响空间档位名（小房间 / Small room…） */
export function reverbKindLabel(locale: Locale, kind: ReverbKind): string {
  return translate(locale, `audio.reverb.kind.${kind}`);
}

/**
 * 升降调读数：「原调」/「+3 半音」/「-5 半音」。
 *
 * 数字走 `Intl` 的 signDisplay，中文与英文的半音单位词分别由
 * `common.unit.semitone` 给（这里直接用本地化数字 + 调用方拼单位，
 * 因为「半音 / semitones」的词在目录里，见 audio.pitch.shifted）。
 */
export function pitchLabel(locale: Locale, semitones: number): string {
  const value = Number.isFinite(semitones) ? Math.round(semitones) : 0;
  if (!pitchActive(value)) return translate(locale, 'audio.pitch.original');
  const fmt = createFormatters(locale);
  return translate(locale, 'audio.pitch.shifted', { semitones: fmt.signed(value) });
}

/**
 * 混响摘要：「原声」/「大厅 65%」。
 *
 * 与 `shared/mix.ts` 的 `describeReverb` 同一套判定（最近锚点 + 湿度百分比），
 * 只是把词换成当前语言的。100% 时不显示数字 —— 满湿度就读档位名本身。
 */
export function reverbSummary(locale: Locale, space: number, wet: number): string {
  const s = Number.isFinite(space) ? Math.min(1, Math.max(0, space)) : 0;
  const w = Number.isFinite(wet) ? Math.min(1, Math.max(0, wet)) : 0;
  if (s <= 0 || w <= 0) return translate(locale, 'audio.reverb.kind.dry');
  const kind = reverbKindLabel(locale, nearestReverbKind(s));
  const pct = Math.round(w * 100);
  if (pct >= 100) return kind;
  return translate(locale, 'audio.reverb.summary', { space: kind, wet: pct });
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useRef, useState } from 'react';
import { PITCH_LIMITS, type TrackSummary } from '../../../shared/types';
import { describePitch } from '../../../shared/mix';
import { api, health } from '../api';
import { errorMessage } from '../utils';

/**
 * 升降调控件（伴奏移调）。
 *
 * 三处复用：桌面演唱页、手机演唱页、伴奏编辑弹窗。之所以抽成组件而不是各写
 * 一份：这里藏着三件容易做错的小事 ——
 *
 *  1. **拖动过程中不能每个像素都发请求**。滑块一步 1 半音，从 −12 拖到 +12
 *     会发 24 个 PATCH、排 24 个移调任务。停手 400ms 才提交（与歌词对轴同口径）。
 *  2. **服务端生成要几秒**。这期间播放回落到原调（accompFileFor 的规则），
 *     所以状态必须说清楚「正在生成」，演唱页还要靠它挡住「开始演唱」。
 *  3. **同一个 URL 背后会换文件**。移调伴奏生成好之后浏览器不会自己重新加载
 *     `<audio>`，页面要跟着状态涨一个版本号（见 onStatusChange）。
 *
 * ffmpeg 缺 rubberband 时控件直接禁用并说明原因 —— 探测在服务端做一次，
 * 这里只读 /api/health 的结果。
 *
 * `data-mix-param` 是与混音面板同一套的 e2e 定位钩子（见 MixPanel 的说明）。
 */

/** /api/health 的能力探测结果：整个页面只拉一次 */
let healthPromise: Promise<boolean> | null = null;

function pitchSupported(): Promise<boolean> {
  if (!healthPromise) {
    healthPromise = health()
      .then((result) => result.capabilities?.rubberband === true)
      .catch(() => {
        // 探测失败（网络抖动 / 服务刚起）不缓存结论：下次挂载再试，
        // 别让一次偶然的失败把升降调永久禁掉
        healthPromise = null;
        return false;
      });
  }
  return healthPromise;
}

/** 停手多久才写库（ms）：拖动过程中每毫秒都在变，发请求会刷爆接口 */
const COMMIT_DELAY_MS = 400;

export interface PitchControlProps {
  /** 伴奏当前状态（列表行 / 详情都行，都要带 pitch 三个字段） */
  track: TrackSummary;
  /** 禁用（录音中、保存中等） */
  disabled?: boolean;
  /** 紧凑排布（手机端） */
  compact?: boolean;
  /** 移调状态变化时回调：调用方据此给媒体地址涨版本号，让浏览器重新加载 */
  onStatusChange?: (status: TrackSummary['pitchStatus']) => void;
  /** 写库失败时的回调（页面自己决定怎么展示） */
  onError?: (message: string) => void;
}

export function PitchControl({
  track,
  disabled = false,
  compact = false,
  onStatusChange,
  onError,
}: PitchControlProps) {
  const [semitones, setSemitones] = useState(track.pitchSemitones);
  /** 用户是否正在拖（拖动中不回弹服务端的值） */
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const [supported, setSupported] = useState(true);
  const [saving, setSaving] = useState(false);

  // ffmpeg 能力：探不到就禁用（默认当支持，避免探测请求失败时误禁）
  useEffect(() => {
    let cancelled = false;
    void pitchSupported().then((value) => {
      if (!cancelled) setSupported(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 服务端值变化（轮询刷新 / 任务完成）时同步显示；用户正在拖则不动
  useEffect(() => {
    if (!dirtyRef.current) setSemitones(track.pitchSemitones);
  }, [track.pitchSemitones]);

  // 移调状态变化（排队 → 就绪 / 失败）通知页面：媒体地址该涨版本号了
  const lastStatusRef = useRef(track.pitchStatus);
  useEffect(() => {
    if (lastStatusRef.current === track.pitchStatus) return;
    lastStatusRef.current = track.pitchStatus;
    onStatusChange?.(track.pitchStatus);
  }, [track.pitchStatus, onStatusChange]);

  // 卸载时丢掉待发的写库请求
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const commit = (next: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setSaving(true);
    void api
      .updateTrack(track.id, { pitchSemitones: next })
      .catch((err: unknown) => {
        onError?.(errorMessage(err, '升降调保存失败'));
      })
      .finally(() => setSaving(false));
  };

  const change = (next: number) => {
    const clamped = Math.max(
      PITCH_LIMITS.semitones.min,
      Math.min(PITCH_LIMITS.semitones.max, Math.round(next)),
    );
    dirtyRef.current = true;
    setSemitones(clamped);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dirtyRef.current = false;
      commit(clamped);
    }, COMMIT_DELAY_MS);
  };

  const status = track.pitchStatus;
  const generating = status === 'processing';
  const sliderDisabled = disabled || generating || !supported;

  const statusLine = !supported ? (
    <div className="small faint">
      当前 ffmpeg 不带 rubberband，升降调不可用（其余功能不受影响）。
      换一个带 <code>--enable-librubberband</code> 的构建即可启用。
    </div>
  ) : generating ? (
    <div className="small faint">
      <span className="spin" style={{ marginRight: 6 }} />
      正在生成新调的伴奏（几秒）…这期间播放和试听听到的还是原调，生成好会自动换过来。
    </div>
  ) : status === 'failed' ? (
    <div className="small" style={{ color: 'var(--danger)' }}>
      移调失败：{track.pitchError ?? '未知原因'}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ marginLeft: 8 }}
        disabled={disabled}
        onClick={() => commit(semitones)}
      >
        重试
      </button>
    </div>
  ) : semitones === 0 ? (
    <div className="small faint">按原调播放。唱不上去就往右拖，伴奏会整体移调，时长不变。</div>
  ) : (
    <div className="small faint">
      已按「{describePitch(semitones)}」生成伴奏：演唱、实时试听、成品 MP3 用的都是这一份。
    </div>
  );

  const label = describePitch(semitones);

  return (
    <div className={compact ? 'm-field' : 'field'}>
      <div className={compact ? 'm-field-label' : 'field-label'}>
        <span>升降调</span>
        <span className={compact ? 'm-faint' : 'field-value'}>{label}</span>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="range"
          data-mix-param="pitchSemitones"
          min={PITCH_LIMITS.semitones.min}
          max={PITCH_LIMITS.semitones.max}
          step={PITCH_LIMITS.semitones.step}
          value={semitones}
          disabled={sliderDisabled}
          aria-label="伴奏升降调（半音）"
          onChange={(event) => change(Number(event.target.value))}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={sliderDisabled || semitones === 0}
          onClick={() => change(0)}
        >
          原调
        </button>
      </div>
      {statusLine}
      {saving && <div className="small faint">正在保存…</div>}
    </div>
  );
}

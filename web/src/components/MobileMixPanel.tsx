//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MIX_PARAMS,
  MIX_LIMITS,
  VOCAL_PRESETS,
  type MixParams,
} from '../../../shared/types';
import { matchPreset, nearestReverbKind, presetParams } from '../../../shared/mix';
import { useI18n } from '../i18n';
import { presetLabel, reverbKindLabel } from '../i18n/labels';

interface Props {
  /** 作品当前的混音参数 */
  value: MixParams;
  /** 每次改动都回调（不触网）：实时试听引擎靠它立即生效 */
  onParamsChange?: (params: MixParams) => void;
}

function gainLabel(value: number, t: (key: string) => string): string {
  if (value <= 0.001) return t('audio.gain.muted');
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} ${t('audio.unit.decibel')}`;
}

function dbLabel(value: number, t: (key: string) => string): string {
  if (Math.abs(value) < 0.05) return `0 ${t('audio.unit.decibel')}`;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} ${t('audio.unit.decibel')}`;
}

/** 全字段比较（不看键顺序）：轮询每次都会造新对象，必须按内容比较 */
function sameParams(a: MixParams, b: MixParams): boolean {
  const keys = Object.keys(a) as (keyof MixParams)[];
  return keys.every((key) => a[key] === b[key]);
}

/**
 * 对齐微调的毫秒输入框：滑块粗调，这里输精确值。
 * 输入中途（空串 / 只有 "-"）不报错，失焦时归一化。
 */
function OffsetMsInput({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const [text, setText] = useState(() => String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    const clamped = Math.min(
      MIX_LIMITS.userOffsetMs.max,
      Math.max(MIX_LIMITS.userOffsetMs.min, Math.round(parsed)),
    );
    onChange(clamped);
  };

  return (
    <input
      className="m-ms-input"
      type="number"
      inputMode="numeric"
      min={MIX_LIMITS.userOffsetMs.min}
      max={MIX_LIMITS.userOffsetMs.max}
      step={MIX_LIMITS.userOffsetMs.step}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        commit(event.target.value);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** 一行滑块：标签 + 滑块 + 读数（手机上一行放得下，比桌面更紧凑） */
function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  param,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  /** 自动化（e2e）定位钩子；只给需要它的参数（目前是混响） */
  param?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="m-slider-row">
      <span className="m-slider-label">{label}</span>
      <input
        type="range"
        data-mix-param={param}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="m-slider-value">{display}</span>
    </div>
  );
}

/**
 * 手机端效果调整面板。
 *
 * 参数口径与桌面 MixPanel **完全一致**（同一批共享常量、同一套预设写入逻辑），
 * 差别只在排版与说明的呈现方式：
 *  · 桌面靠 hover 气泡藏说明，触屏没有 hover —— 说明改成常驻小字，
 *    但只留真正会踩坑的两条（降噪只在成品生效、去齿音是近似）；
 *  · 预设用可横滑的 chip，不占竖向空间；混响是「空间 + 湿度」两个连续滑块（见下）；
 *  · **「合成」只有一处**：页面（MobileWorkEditPage）的粘底栏。面板里不再放按钮 ——
 *    长面板滚到底时用户要的是"不用滑回去也能合成"，一个悬停/常驻的粘底栏就够，
 *    两个入口只会让人犹豫点哪个。
 */
export function MobileMixPanel({ value, onParamsChange }: Props) {
  const { t, fmt, locale } = useI18n();
  const [params, setParams] = useState<MixParams>(value ?? DEFAULT_MIX_PARAMS);
  const paramsRef = useRef(params);

  // 作品数据刷新后同步到服务端真实值；用户有未提交改动时不被覆盖
  useEffect(() => {
    const synced = value ?? DEFAULT_MIX_PARAMS;
    if (paramsRef.current && !sameParams(paramsRef.current, synced)) return;
    paramsRef.current = synced;
    setParams(synced);
  }, [value]);

  const update = (patch: Partial<MixParams>) => {
    const next = { ...paramsRef.current, ...patch };
    paramsRef.current = next;
    setParams(next);
    onParamsChange?.(next);
  };

  const applyPreset = (preset: (typeof VOCAL_PRESETS)[number]) => {
    update({ ...presetParams(preset), vocalPreset: preset });
  };

  const activePreset = matchPreset(params);

  return (
    <div className="m-mix">
      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.preset.title')}</span>
          <span className="m-faint">
            {activePreset
              ? t('components.mix.presetCurrent', { preset: presetLabel(locale, activePreset) })
              : t('components.mix.presetManual')}
          </span>
        </div>
        <div className="m-chip-row m-chip-row-scroll">
          {VOCAL_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`m-chip${activePreset === preset ? ' active' : ''}`}
              onClick={() => applyPreset(preset)}
            >
              {presetLabel(locale, preset)}
            </button>
          ))}
        </div>
        <p className="m-notes">{t('components.mix.presetHint')}</p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.reverb.title')}</span>
          <span className="m-faint">{t('components.mix.reverbAxes')}</span>
        </div>
        {/*
           * 混响 = 空间 + 湿度两个连续滑块。空间轴上是原来的 8 个档位名
           *（手机放不下刻度行，清单写进下面的常驻小字），取值连续：
           * 拖一下走 1%，锚点之间插值，听感平滑过渡。
           */}
        <Slider
          label={t('audio.reverb.space')}
          param="reverbSpace"
          value={params.reverbSpace}
          display={reverbKindLabel(locale, nearestReverbKind(params.reverbSpace))}
          min={MIX_LIMITS.reverb.space.min}
          max={MIX_LIMITS.reverb.space.max}
          step={MIX_LIMITS.reverb.space.step}
          onChange={(reverbSpace) => update({ reverbSpace })}
        />
        <Slider
          label={t('audio.reverb.wet')}
          param="reverbWet"
          value={params.reverbWet}
          display={params.reverbWet <= 0 ? t('audio.reverb.dry') : fmt.percent(params.reverbWet)}
          min={MIX_LIMITS.reverb.wet.min}
          max={MIX_LIMITS.reverb.wet.max}
          step={MIX_LIMITS.reverb.wet.step}
          onChange={(reverbWet) => update({ reverbWet })}
        />
        <p className="m-notes">{t('components.mix.reverbNote')}</p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.gain.title')}</span>
        </div>
        <Slider
          label={t('audio.gain.vocalShort')}
          value={params.vocalGain}
          display={gainLabel(params.vocalGain, t)}
          min={MIX_LIMITS.gain.min}
          max={MIX_LIMITS.gain.max}
          step={MIX_LIMITS.gain.step}
          onChange={(vocalGain) => update({ vocalGain })}
        />
        <Slider
          label={t('audio.gain.accompShort')}
          value={params.accompGain}
          display={gainLabel(params.accompGain, t)}
          min={MIX_LIMITS.gain.min}
          max={MIX_LIMITS.gain.max}
          step={MIX_LIMITS.gain.step}
          onChange={(accompGain) => update({ accompGain })}
        />
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.eq.title')}</span>
          <span className="m-faint">{t('audio.eq.bands')}</span>
        </div>
        <Slider
          label={t('audio.eq.low')}
          value={params.eqLowDb}
          display={dbLabel(params.eqLowDb, t)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqLowDb) => update({ eqLowDb })}
        />
        <Slider
          label={t('audio.eq.mid')}
          value={params.eqMidDb}
          display={dbLabel(params.eqMidDb, t)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqMidDb) => update({ eqMidDb })}
        />
        <Slider
          label={t('audio.eq.high')}
          value={params.eqHighDb}
          display={dbLabel(params.eqHighDb, t)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqHighDb) => update({ eqHighDb })}
        />
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.repair.title')}</span>
          <span className="m-faint">{t('audio.repair.summary')}</span>
        </div>
        <Slider
          label={t('audio.repair.compression')}
          value={params.compression}
          display={fmt.percent(params.compression)}
          min={MIX_LIMITS.amount.min}
          max={MIX_LIMITS.amount.max}
          step={MIX_LIMITS.amount.step}
          onChange={(compression) => update({ compression })}
        />
        <Slider
          label={t('audio.repair.deEss')}
          value={params.deEss}
          display={params.deEss <= 0 ? t('audio.repair.off') : fmt.percent(params.deEss)}
          min={MIX_LIMITS.amount.min}
          max={MIX_LIMITS.amount.max}
          step={MIX_LIMITS.amount.step}
          onChange={(deEss) => update({ deEss })}
        />
        <label className="m-check">
          <input
            type="checkbox"
            checked={params.noiseReduction}
            onChange={(event) => update({ noiseReduction: event.target.checked })}
          />
          {t('audio.repair.noiseReduction')}
        </label>
        <p className="m-notes">{t('components.mix.repairNote')}</p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>{t('audio.offset.title')}</span>
          <span className="m-faint">{t('audio.offset.range')}</span>
        </div>
        <div className="m-offset-row">
          <OffsetMsInput value={params.userOffsetMs} onChange={(next) => update({ userOffsetMs: next })} />
          <span className="m-slider-value">{t('common.unit.millisecond')}</span>
          <input
            type="range"
            min={MIX_LIMITS.userOffsetMs.min}
            max={MIX_LIMITS.userOffsetMs.max}
            step={MIX_LIMITS.userOffsetMs.step}
            value={params.userOffsetMs}
            onChange={(event) => update({ userOffsetMs: Number(event.target.value) })}
          />
        </div>
        <p className="m-notes">{t('audio.offset.hint')}</p>
      </section>

    </div>
  );
}

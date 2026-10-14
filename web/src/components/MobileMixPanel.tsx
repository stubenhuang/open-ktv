import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MIX_PARAMS,
  MIX_LIMITS,
  REVERB_LABELS,
  VOCAL_PRESETS,
  VOCAL_PRESET_LABELS,
  type MixParams,
} from '../../../shared/types';
import { matchPreset, nearestReverbKind, presetParams } from '../../../shared/mix';

interface Props {
  /** 作品当前的混音参数 */
  value: MixParams;
  /** 每次改动都回调（不触网）：实时试听引擎靠它立即生效 */
  onParamsChange?: (params: MixParams) => void;
}

function gainLabel(value: number): string {
  if (value <= 0.001) return '静音';
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function dbLabel(value: number): string {
  if (Math.abs(value) < 0.05) return '0 dB';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
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
          <span>人声预设</span>
          <span className="m-faint">
            {activePreset ? `当前：${VOCAL_PRESET_LABELS[activePreset]}` : '已手动调整'}
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
              {VOCAL_PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        <p className="m-notes">点一下把那组参数写进下面的滑块，之后还能继续手调。</p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>人声混响</span>
          <span className="m-faint">空间由小到大 · 湿度独立</span>
        </div>
        {/*
           * 混响 = 空间 + 湿度两个连续滑块。空间轴上是原来的 8 个档位名
           *（手机放不下刻度行，清单写进下面的常驻小字），取值连续：
           * 拖一下走 1%，锚点之间插值，听感平滑过渡。
           */}
        <Slider
          label="空间"
          param="reverbSpace"
          value={params.reverbSpace}
          display={REVERB_LABELS[nearestReverbKind(params.reverbSpace)]}
          min={MIX_LIMITS.reverb.space.min}
          max={MIX_LIMITS.reverb.space.max}
          step={MIX_LIMITS.reverb.space.step}
          onChange={(reverbSpace) => update({ reverbSpace })}
        />
        <Slider
          label="湿度"
          param="reverbWet"
          value={params.reverbWet}
          display={params.reverbWet <= 0 ? '干声' : `${Math.round(params.reverbWet * 100)}%`}
          min={MIX_LIMITS.reverb.wet.min}
          max={MIX_LIMITS.reverb.wet.max}
          step={MIX_LIMITS.reverb.wet.step}
          onChange={(reverbWet) => update({ reverbWet })}
        />
        <p className="m-notes">
          「空间」在原声 / 小房间 / 金属板 / 大厅 / 演唱会 / 教堂 / 体育场 / 峡谷之间连续过渡，
          「湿度」独立控制混响量（0% = 干声）；预设只是起点，之后可继续微调，试听立即生效。
        </p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>音量</span>
        </div>
        <Slider
          label="人声"
          value={params.vocalGain}
          display={gainLabel(params.vocalGain)}
          min={MIX_LIMITS.gain.min}
          max={MIX_LIMITS.gain.max}
          step={MIX_LIMITS.gain.step}
          onChange={(vocalGain) => update({ vocalGain })}
        />
        <Slider
          label="伴奏"
          value={params.accompGain}
          display={gainLabel(params.accompGain)}
          min={MIX_LIMITS.gain.min}
          max={MIX_LIMITS.gain.max}
          step={MIX_LIMITS.gain.step}
          onChange={(accompGain) => update({ accompGain })}
        />
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>均衡</span>
          <span className="m-faint">低 200Hz · 中 1.2kHz · 高 4kHz</span>
        </div>
        <Slider
          label="低音"
          value={params.eqLowDb}
          display={dbLabel(params.eqLowDb)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqLowDb) => update({ eqLowDb })}
        />
        <Slider
          label="中音"
          value={params.eqMidDb}
          display={dbLabel(params.eqMidDb)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqMidDb) => update({ eqMidDb })}
        />
        <Slider
          label="高音"
          value={params.eqHighDb}
          display={dbLabel(params.eqHighDb)}
          min={MIX_LIMITS.eqDb.min}
          max={MIX_LIMITS.eqDb.max}
          step={MIX_LIMITS.eqDb.step}
          onChange={(eqHighDb) => update({ eqHighDb })}
        />
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>修音</span>
          <span className="m-faint">压缩 · 去齿音 · 降噪</span>
        </div>
        <Slider
          label="压缩"
          value={params.compression}
          display={`${Math.round(params.compression * 100)}%`}
          min={MIX_LIMITS.amount.min}
          max={MIX_LIMITS.amount.max}
          step={MIX_LIMITS.amount.step}
          onChange={(compression) => update({ compression })}
        />
        <Slider
          label="去齿音"
          value={params.deEss}
          display={params.deEss <= 0 ? '关闭' : `${Math.round(params.deEss * 100)}%`}
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
          降噪
        </label>
        <p className="m-notes">
          去齿音在试听里是近似效果；降噪只该在录音有明显底噪时开，且**只在合成后的成品里生效**。
        </p>
      </section>

      <section className="m-mix-group">
        <div className="m-mix-group-head">
          <span>人声对齐</span>
          <span className="m-faint">±1000ms</span>
        </div>
        <div className="m-offset-row">
          <OffsetMsInput value={params.userOffsetMs} onChange={(next) => update({ userOffsetMs: next })} />
          <span className="m-slider-value">ms</span>
          <input
            type="range"
            min={MIX_LIMITS.userOffsetMs.min}
            max={MIX_LIMITS.userOffsetMs.max}
            step={MIX_LIMITS.userOffsetMs.step}
            value={params.userOffsetMs}
            onChange={(event) => update({ userOffsetMs: Number(event.target.value) })}
          />
        </div>
        <p className="m-notes">正值 = 人声更晚（抢拍），负值 = 更早（拖拍）。起录时那段静音已自动扣除。</p>
      </section>

    </div>
  );
}

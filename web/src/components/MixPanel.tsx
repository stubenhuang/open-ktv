import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MIX_PARAMS,
  MIX_LIMITS,
  REVERB_KINDS,
  REVERB_LABELS,
  VOCAL_PRESETS,
  VOCAL_PRESET_LABELS,
  type MixParams,
} from '../../../shared/types';
import { matchPreset, presetParams } from '../../../shared/mix';

interface Props {
  /** 作品当前的混音参数 */
  value: MixParams;
  /** 合成请求 in-flight：只用于按钮 loading，不禁用控件（试听随时可调） */
  busy: boolean;
  onApply: (params: MixParams) => void;
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

/**
 * 全字段比较（不看键顺序）。
 * 轮询每次都会造新的 mixParams 对象，必须按内容比较才不会把用户拖到一半的滑块弹回去。
 */
function sameParams(a: MixParams, b: MixParams): boolean {
  const keys = Object.keys(a) as (keyof MixParams)[];
  return keys.every((key) => a[key] === b[key]);
}

/**
 * 对齐微调的毫秒输入框：滑块负责粗调，这里负责直接输入精确值。
 * 正值 = 人声更晚（抢拍），负值 = 人声更早（拖拍）；自动对齐已扣除先录的静音。
 * 输入中途（空串 / 只有 "-"）不报错，失焦时把显示归一化到合法值。
 */
function OffsetMsInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const [text, setText] = useState(() => String(value));

  // 外部值变化（作品刷新 / 合成完成）时同步显示
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
      className="ms-input"
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

/** 折叠分组：原生 details，不引状态 */
function Group({
  title,
  hint,
  children,
  open = true,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="mix-group" open={open}>
      <summary className="mix-group-head">
        <span>{title}</span>
        {hint && <span className="small faint">{hint}</span>}
      </summary>
      <div className="mix-group-body">{children}</div>
    </details>
  );
}

export function MixPanel({ value, busy, onApply, onParamsChange }: Props) {
  const [params, setParams] = useState<MixParams>(value ?? DEFAULT_MIX_PARAMS);
  /** 最新参数的一份镜像：setParams 的函数式更新拿不到同步的 next，实时回调需要它 */
  const paramsRef = useRef(params);

  // 作品数据刷新后把面板同步到服务端的真实值。
  // 但用户有未提交改动时不能被轮询刷新覆盖 —— 合成中也可以继续拖滑块调实时试听。
  // （轮询每次都会造新的 mixParams 对象，必须按内容比较，不能比对象身份）
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
    // 实时试听：改动立刻送到引擎，不发请求
    onParamsChange?.(next);
  };

  /** 点预设 = 把那组数值写进参数（预设本身不参与 DSP，见 shared/mix.ts） */
  const applyPreset = (preset: (typeof VOCAL_PRESETS)[number]) => {
    update({ ...presetParams(preset), vocalPreset: preset });
  };

  const activePreset = matchPreset(params);

  return (
    <div className="card mix-panel">
      <div>
        <div className="page-title" style={{ fontSize: 17 }}>
          混音调整
        </div>
        <p className="page-sub" style={{ marginTop: 2 }}>
          拖动滑块 / 输入毫秒数会实时应用到上面的「实时试听」；点「合成」服务端会用干声重新出一版 MP3，然后自动返回作品库。
        </p>
      </div>

      <Group title="音量">
        <div className="mix-volume-grid">
          <div className="field">
            <div className="field-label">
              <span>人声音量</span>
              <span className="field-value">{gainLabel(params.vocalGain)}</span>
            </div>
            <input
              type="range"
              min={MIX_LIMITS.gain.min}
              max={MIX_LIMITS.gain.max}
              step={MIX_LIMITS.gain.step}
              value={params.vocalGain}
              onChange={(event) => update({ vocalGain: Number(event.target.value) })}
            />
          </div>

          <div className="field">
            <div className="field-label">
              <span>伴奏音量</span>
              <span className="field-value">{gainLabel(params.accompGain)}</span>
            </div>
            <input
              type="range"
              min={MIX_LIMITS.gain.min}
              max={MIX_LIMITS.gain.max}
              step={MIX_LIMITS.gain.step}
              value={params.accompGain}
              onChange={(event) => update({ accompGain: Number(event.target.value) })}
            />
          </div>
        </div>
      </Group>

      <Group title="音效">
        <div className="field">
          <div className="field-label">
            <span>预设</span>
            <span className="faint small">
              {activePreset ? `当前：${VOCAL_PRESET_LABELS[activePreset]}` : '已手动调整'}
            </span>
          </div>
          <div className="reverb-options">
            {VOCAL_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`reverb-option${activePreset === preset ? ' active' : ''}`}
                onClick={() => applyPreset(preset)}
              >
                {VOCAL_PRESET_LABELS[preset]}
              </button>
            ))}
          </div>
          <div className="small faint">点一下就把那组参数写进下面的滑块，之后还能继续手调。</div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <div className="field-label">
            <span>人声混响</span>
          </div>
          <div className="reverb-options">
            {REVERB_KINDS.map((reverb) => (
              <button
                key={reverb}
                type="button"
                className={`reverb-option${params.reverb === reverb ? ' active' : ''}`}
                onClick={() => update({ reverb })}
              >
                {REVERB_LABELS[reverb]}
              </button>
            ))}
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <div className="field-label">
            <span>均衡</span>
            <span className="faint small">低 200Hz · 中 1.2kHz · 高 4kHz</span>
          </div>
          {(
            [
              ['eqLowDb', '低频'],
              ['eqMidDb', '中频'],
              ['eqHighDb', '高频'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="row" style={{ gap: 10, marginTop: 8 }}>
              <span className="small muted" style={{ width: 42, flex: '0 0 auto' }}>
                {label}
              </span>
              <input
                type="range"
                style={{ flex: 1 }}
                min={MIX_LIMITS.eqDb.min}
                max={MIX_LIMITS.eqDb.max}
                step={MIX_LIMITS.eqDb.step}
                value={params[key]}
                onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<MixParams>)}
              />
              <span className="small mono" style={{ width: 58, textAlign: 'right', flex: '0 0 auto' }}>
                {dbLabel(params[key])}
              </span>
            </div>
          ))}
        </div>
      </Group>

      <Group title="修音" open={false}>
        <div className="field">
          <div className="field-label">
            <span>压缩量</span>
            <span className="field-value">{Math.round(params.compression * 100)}%</span>
          </div>
          <input
            type="range"
            min={MIX_LIMITS.amount.min}
            max={MIX_LIMITS.amount.max}
            step={MIX_LIMITS.amount.step}
            value={params.compression}
            onChange={(event) => update({ compression: Number(event.target.value) })}
          />
          <div className="small faint">把人声的动态压平一些，小声的句子不会被伴奏盖住。</div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <div className="field-label">
            <span>去齿音</span>
            <span className="field-value">
              {params.deEss <= 0 ? '关闭' : `${Math.round(params.deEss * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            min={MIX_LIMITS.amount.min}
            max={MIX_LIMITS.amount.max}
            step={MIX_LIMITS.amount.step}
            value={params.deEss}
            onChange={(event) => update({ deEss: Number(event.target.value) })}
          />
          <div className="small faint">压一下「嘶 / 次」这类刺耳的高频。试听里是近似效果。</div>
        </div>

        <label className="row small muted" style={{ gap: 8, cursor: 'pointer', marginTop: 14 }}>
          <input
            type="checkbox"
            checked={params.noiseReduction}
            onChange={(event) => update({ noiseReduction: event.target.checked })}
          />
          降噪（只该在录音有明显底噪时开；**实时试听里不生效**）
        </label>
      </Group>

      <Group title="人声对齐微调" open={false}>
        <div className="field">
          <div className="field-label">
            <span>对齐微调</span>
            <span className="offset-value">
              <OffsetMsInput
                value={params.userOffsetMs}
                onChange={(next) => update({ userOffsetMs: next })}
              />
              <span className="field-value">ms</span>
            </span>
          </div>
          <input
            type="range"
            min={MIX_LIMITS.userOffsetMs.min}
            max={MIX_LIMITS.userOffsetMs.max}
            step={MIX_LIMITS.userOffsetMs.step}
            value={params.userOffsetMs}
            onChange={(event) => update({ userOffsetMs: Number(event.target.value) })}
          />
          <div className="small faint">
            范围 ±1000ms：正值 = 人声更晚（人声比伴奏早、抢拍时用）；负值 = 人声更早（人声拖拍时用）。
            自动对齐已经先扣掉了「起录后、伴奏起播前」那段静音，微调在此基础上正负叠加。
          </div>
        </div>
      </Group>

      <button
        type="button"
        className="btn btn-primary btn-lg mix-apply"
        disabled={busy}
        onClick={() => onApply(params)}
      >
        {busy ? (
          <>
            <span className="spin" />
            合成中…
          </>
        ) : (
          '合成'
        )}
      </button>
    </div>
  );
}

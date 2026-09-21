import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MIX_PARAMS,
  MIX_LIMITS,
  REVERB_LABELS,
  type MixParams,
  type ReverbKind,
} from '../../../shared/types';

const REVERB_ORDER: ReverbKind[] = ['dry', 'room', 'hall', 'stage'];

interface Props {
  /** 作品当前的混音参数 */
  value: MixParams;
  busy: boolean;
  disabled?: boolean;
  onApply: (params: MixParams) => void;
  /** 每次改动都回调（不触网）：实时试听引擎靠它立即生效 */
  onParamsChange?: (params: MixParams) => void;
}

function gainLabel(value: number): string {
  if (value <= 0.001) return '静音';
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/**
 * 对齐微调的毫秒输入框：滑块负责粗调，这里负责直接输入精确值。
 * 输入中途（空串 / 只有 "-"）不报错，失焦时把显示归一化到合法值。
 */
function OffsetMsInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  const [text, setText] = useState(() => String(value));

  // 外部值变化（作品刷新 / 重新生成完成）时同步显示
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
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        commit(event.target.value);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

export function MixPanel({ value, busy, disabled, onApply, onParamsChange }: Props) {
  const [params, setParams] = useState<MixParams>(value ?? DEFAULT_MIX_PARAMS);
  /** 最新参数的一份镜像：setParams 的函数式更新拿不到同步的 next，实时回调需要它 */
  const paramsRef = useRef(params);

  const dirty =
    params.vocalGain !== value.vocalGain ||
    params.accompGain !== value.accompGain ||
    params.reverb !== value.reverb ||
    params.userOffsetMs !== value.userOffsetMs;

  // 作品数据刷新后（比如重混完成）把面板同步到服务端的真实值。
  // 但用户有未提交改动时不能被轮询刷新覆盖 —— 混音中也可以继续拖滑块调实时试听。
  useEffect(() => {
    if (dirty) return;
    const synced = value ?? DEFAULT_MIX_PARAMS;
    paramsRef.current = synced;
    setParams(synced);
  }, [value, dirty]);

  const update = (patch: Partial<MixParams>) => {
    const next = { ...paramsRef.current, ...patch };
    paramsRef.current = next;
    setParams(next);
    // 实时试听：改动立刻送到引擎，不发请求
    onParamsChange?.(next);
  };

  return (
    <div className="card mix-panel">
      <div>
        <div className="page-title" style={{ fontSize: 17 }}>
          混音调整
        </div>
        <p className="page-sub" style={{ marginTop: 2 }}>
          拖动滑块 / 输入毫秒数会实时应用到上面的「实时试听」；满意后点「重新生成」，服务端再用干声合成一版可下载的 MP3。
        </p>
      </div>

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
          disabled={disabled}
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
          disabled={disabled}
          onChange={(event) => update({ accompGain: Number(event.target.value) })}
        />
      </div>

      <div className="field">
        <div className="field-label">
          <span>人声混响</span>
        </div>
        <div className="reverb-options">
          {REVERB_ORDER.map((reverb) => (
            <button
              key={reverb}
              type="button"
              disabled={disabled}
              className={`reverb-option${params.reverb === reverb ? ' active' : ''}`}
              onClick={() => update({ reverb })}
            >
              {REVERB_LABELS[reverb]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>人声对齐微调</span>
          <span className="offset-value">
            <OffsetMsInput
              value={params.userOffsetMs}
              disabled={Boolean(disabled)}
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
          disabled={disabled}
          onChange={(event) => update({ userOffsetMs: Number(event.target.value) })}
        />
        <div className="small faint">
          范围 ±1000ms：觉得人声比伴奏早 → 往右拖或输入正值；觉得人声拖拍 → 往左拖或输入负值。
          也可以直接在输入框里填毫秒数。
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary"
        disabled={disabled || busy || !dirty}
        onClick={() => onApply(params)}
      >
        {busy ? (
          <>
            <span className="spin" />
            正在重新生成…
          </>
        ) : dirty ? (
          '重新生成'
        ) : (
          '参数未改动'
        )}
      </button>
    </div>
  );
}

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
import { Hint } from './Hint';

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

/**
 * 一条滑块：标签 + 悬停说明 + 当前值 + range。
 *
 * 说明不再常驻一行，改成标签旁的小图标（见 Hint.tsx）—— 编辑页要一屏放完，
 * 每个控件挂一行解释会把面板撑出两屏。
 *
 * `data-mix-param` 是给自动化（e2e）用的定位钩子 —— 面板里滑块越来越多，
 * 靠「第几个 input[type=range]」定位太脆，改一个排布就会点错参数。
 */
function Slider({
  param,
  label,
  value,
  display,
  min,
  max,
  step,
  hint,
  tone = 'info',
  placement = 'right',
  flipNarrow = false,
  onChange,
}: {
  param: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  /** 悬停才展开的说明；不给就只显示标签 */
  hint?: string;
  tone?: 'info' | 'warn';
  /** 气泡展开方向：右半列的控件要朝左，才不顶出视口 */
  placement?: 'right' | 'left' | 'top';
  /** 窄屏单列时把朝左翻回朝右 */
  flipNarrow?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span className="label-with-hint">
          {label}
          {hint && <Hint text={hint} tone={tone} placement={placement} flipNarrow={flipNarrow} />}
        </span>
        <span className="field-value">{display}</span>
      </div>
      <input
        type="range"
        data-mix-param={param}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/**
 * 分组：标题 + 内容。
 *
 * 这里**刻意不用 <details> 折叠**：编辑页要求所有元素一屏放完，折叠起来的
 * 分组既违反「修音部分不能折叠」，也会让「不滚动就看到全部控件」变成空话。
 * 所以四个分组全部常驻展开，分组头只做分区标题（不再有箭头/点击手势）。
 */
function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mix-group">
      <div className="mix-group-head">
        <span>{title}</span>
        {hint && <span className="small faint">{hint}</span>}
      </div>
      <div className="mix-group-body">{children}</div>
    </section>
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
      <div className="mix-panel-head">
        <span className="mix-panel-title">
          混音调整
          <Hint text="所有改动都会实时送进上面的「实时试听」；点「合成」服务端用干声重新出一版 MP3，然后自动返回作品库。" />
        </span>
      </div>

      {/*
        * 两列排布：左列是「音效」（预设 10 + 混响 8 + 均衡 3，最高的一列），
        * 右列是音量 / 修音 / 对齐 + 合成。两列高度接近，整块面板一屏放得下。
        */}
      <div className="mix-columns">
        <div className="mix-col">
          <Group title="音效" hint={`${VOCAL_PRESETS.length} 种预设 · ${REVERB_KINDS.length} 种混响`}>
            <div className="field">
              <div className="field-label">
                <span className="label-with-hint">
                  人声预设
                  <Hint text="点一下就把那组参数写进下面的滑块，之后还能继续手调；手调过就不再高亮任何预设。" />
                </span>
                <span className="faint small">
                  {activePreset ? `当前：${VOCAL_PRESET_LABELS[activePreset]}` : '已手动调整'}
                </span>
              </div>
              <div className="option-grid">
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
            </div>

            <div className="field">
              <div className="field-label">
                <span>人声混响</span>
                <span className="faint small">空间由小到大</span>
              </div>
              <div className="option-grid option-grid-4">
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

            <div className="field">
              <div className="field-label">
                <span>均衡</span>
                <span className="faint small">低 200Hz · 中 1.2kHz · 高 4kHz</span>
              </div>
              <div className="eq-grid">
                {(
                  [
                    ['eqLowDb', '低频'],
                    ['eqMidDb', '中频'],
                    ['eqHighDb', '高频'],
                  ] as const
                ).map(([key, label]) => (
                  <Slider
                    key={key}
                    param={key}
                    label={label}
                    value={params[key]}
                    display={dbLabel(params[key])}
                    min={MIX_LIMITS.eqDb.min}
                    max={MIX_LIMITS.eqDb.max}
                    step={MIX_LIMITS.eqDb.step}
                    onChange={(next) => update({ [key]: next } as Partial<MixParams>)}
                  />
                ))}
              </div>
            </div>
          </Group>
        </div>

        <div className="mix-col">
          <Group title="音量">
            <div className="mix-volume-grid">
              <Slider
                param="vocalGain"
                label="人声音量"
                value={params.vocalGain}
                display={gainLabel(params.vocalGain)}
                min={MIX_LIMITS.gain.min}
                max={MIX_LIMITS.gain.max}
                step={MIX_LIMITS.gain.step}
                onChange={(vocalGain) => update({ vocalGain })}
              />
              <Slider
                param="accompGain"
                label="伴奏音量"
                value={params.accompGain}
                display={gainLabel(params.accompGain)}
                min={MIX_LIMITS.gain.min}
                max={MIX_LIMITS.gain.max}
                step={MIX_LIMITS.gain.step}
                onChange={(accompGain) => update({ accompGain })}
              />
            </div>
          </Group>

          {/* 修音：常驻展开，不提供折叠（用户要能一眼看到压缩/去齿音/降噪） */}
          <Group title="修音" hint="压缩 · 去齿音 · 降噪">
            <div className="mix-fix-grid">
              <Slider
                param="compression"
                label="压缩量"
                value={params.compression}
                display={`${Math.round(params.compression * 100)}%`}
                min={MIX_LIMITS.amount.min}
                max={MIX_LIMITS.amount.max}
                step={MIX_LIMITS.amount.step}
                hint="把人声的动态压平一些，小声的句子不会被伴奏盖住。"
                onChange={(compression) => update({ compression })}
              />
              <Slider
                param="deEss"
                label="去齿音"
                value={params.deEss}
                display={params.deEss <= 0 ? '关闭' : `${Math.round(params.deEss * 100)}%`}
                min={MIX_LIMITS.amount.min}
                max={MIX_LIMITS.amount.max}
                step={MIX_LIMITS.amount.step}
                hint="压掉「嘶 / 次」这类刺耳的高频。试听里是静态高架下压的近似效果，成品里才是真正的 deesser。"
                tone="warn"
                placement="left"
                flipNarrow
                onChange={(deEss) => update({ deEss })}
              />            </div>
            {/* 降噪的说明挂在标签外：按钮嵌在 <label> 里会顺带勾选复选框 */}
            <div className="row small muted mix-check">
              <label className="mix-check-label" htmlFor="mix-noise-reduction">
                <input
                  id="mix-noise-reduction"
                  type="checkbox"
                  checked={params.noiseReduction}
                  onChange={(event) => update({ noiseReduction: event.target.checked })}
                />
                降噪
              </label>
              <Hint
                tone="warn"
                text="只该在录音有明显底噪时开。实时试听里不生效，只在「合成」后的成品里生效。"
              />
            </div>
          </Group>

          <Group title="人声对齐微调" hint="±1000ms">
            <div className="mix-offset-row">
              {/* 说明挂在行首：整行都是「这一个参数」，朝上展开（这是右列最底下一个控件） */}
              <Hint
                placement="top"
                text="正值 = 人声更晚（抢拍时用），负值 = 人声更早（拖拍用）。自动对齐已经先扣掉了「起录后、伴奏起播前」那段静音，微调在此基础上正负叠加。"
              />
              <OffsetMsInput
                value={params.userOffsetMs}
                onChange={(next) => update({ userOffsetMs: next })}
              />
              <span className="field-value">ms</span>
              <input
                type="range"
                data-mix-param="userOffsetMs"
                min={MIX_LIMITS.userOffsetMs.min}
                max={MIX_LIMITS.userOffsetMs.max}
                step={MIX_LIMITS.userOffsetMs.step}
                value={params.userOffsetMs}
                onChange={(event) => update({ userOffsetMs: Number(event.target.value) })}
              />
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
      </div>
    </div>
  );
}

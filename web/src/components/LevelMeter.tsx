import { useEffect, useRef } from 'react';
import type { KtvEngine } from '../audio/engine';

interface Props {
  /** 传 null 表示引擎还没建好 */
  engine: KtvEngine | null;
  active: boolean;
  height?: number;
}

/**
 * 实时麦克风音量条。
 *
 * 直接写 DOM style，不走 setState —— 每秒 60 次重渲染在这里毫无必要。
 * 用「峰值保持」而不是瞬时值，读数才不会乱跳。
 */
export function LevelMeter({ engine, active }: Props) {
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;

    if (!engine || !active) {
      fill.style.width = '0%';
      return;
    }

    let frame = 0;
    let held = 0;

    const tick = () => {
      const level = engine.getLevel();
      held = Math.max(level, held * 0.93);
      // 满量程留一点余量：峰值 -12dB 左右就顶到条子 90%
      fill.style.width = `${Math.min(100, held * 145)}%`;
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, active]);

  return (
    <div className="meter">
      <div ref={fillRef} className="meter-fill" />
    </div>
  );
}

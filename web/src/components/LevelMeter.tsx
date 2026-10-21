//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useRef } from 'react';

/**
 * 音量条的数据源：只要会报电平就行。
 *
 * 刻意不写死 KtvEngine —— 手机端用的是另一套引擎（MobileEngine），
 * 但它俩给音量条提供的接口是同一个。按结构取类型，两边都能复用这一个组件。
 */
export interface LevelSource {
  getLevel(): number;
}

interface Props {
  /** 传 null 表示引擎还没建好 */
  engine: LevelSource | null;
  active: boolean;
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

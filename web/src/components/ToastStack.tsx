import { useEffect, useState } from 'react';

/**
 * 轻提示（toast）：操作成功后的短暂反馈。
 *
 * 和页内 .alert 分工明确：alert 是「错误 / 需要用户处理的状况」，常驻到用户
 * 关掉为止；toast 是「你说一声我知道了」的确认（上传完成、保存成功），
 * 2.6 秒自己消失，不占布局、不打断当前操作。
 *
 * 零依赖实现：模块级订阅器 + App 里挂一个 <ToastStack />。
 * aria-live=polite 让读屏也能听到（不像悬停气泡只给视觉用户）。
 */
export interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

type Listener = (item: ToastItem) => void;

const listeners = new Set<Listener>();
let seq = 0;

function emit(text: string, tone: ToastItem['tone']) {
  seq += 1;
  const item: ToastItem = { id: seq, text, tone };
  for (const listener of listeners) listener(item);
}

export const toast = {
  ok: (text: string) => emit(text, 'ok'),
  error: (text: string) => emit(text, 'error'),
};

const TOAST_MS = 2600;
/** 同时最多留 3 条：再老的会被挤掉（连点十次「保存」不该刷出一屏） */
const MAX_VISIBLE = 3;

export function ToastStack() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (item) => {
      setItems((previous) => [...previous, item].slice(-MAX_VISIBLE));
      window.setTimeout(() => {
        setItems((previous) => previous.filter((one) => one.id !== item.id));
      }, TOAST_MS);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          <span className="toast-icon" aria-hidden="true">
            {item.tone === 'ok' ? '✓' : '!'}
          </span>
          {item.text}
        </div>
      ))}
    </div>
  );
}

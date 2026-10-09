import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 确认弹窗：Promise 化的 window.confirm 替代品。
 *
 * 为什么换掉原生 confirm：系统确认框是另一个世界的灰色小窗，按钮位置、
 * 字体、圆角全不跟主题走；而且它是同步阻塞的，UI 线程被它卡住时动画会掉帧。
 * 自己画之后：Esc / 点遮罩 / 取消 → resolve(false)，确认 → resolve(true)，
 * 调用方还是 `if (!(await confirmAction({...}))) return;` 一行，语义不变。
 *
 * 可访问性：role=dialog + aria-modal；打开时聚焦「取消」（危险操作的确认
 * 按钮不该是默认焦点，误触 Enter 就删掉了）；关闭时把焦点还给打开前的元素。
 */
interface ConfirmOptions {
  title: string;
  /** 支持 \n 换行（删除说明经常要分两段讲后果） */
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除）：确认按钮用 danger 色调 */
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function snapshot() {
  return pending;
}

function emit() {
  for (const listener of listeners) listener();
}

/** 弹出确认框，返回用户是否确认 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 连续两次 confirmAction：前一个直接按「取消」收掉，别把 resolve 吞了
    if (pending) pending.resolve(false);
    pending = { options, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const [state, setState] = useState<PendingConfirm | null>(snapshot);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const listener = () => setState(snapshot());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const settle = useCallback((value: boolean) => {
    if (!pending) return;
    pending.resolve(value);
    pending = null;
    emit();
  }, []);

  // Esc = 取消（和上传弹窗一个行为，全站统一）
  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') settle(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, settle]);

  // 打开聚焦取消、关闭还焦
  useEffect(() => {
    if (!state) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, [state]);

  if (!state) return null;
  const { options } = state;

  return (
    <div
      className="confirm-modal"
      onMouseDown={(event) => {
        // 点遮罩（面板以外）算取消；面板内部点击不关
        if (event.target === event.currentTarget) settle(false);
      }}
    >
      <div className="confirm-panel" role="dialog" aria-modal="true" aria-label={options.title}>
        <div className="confirm-title">{options.title}</div>
        <div className="confirm-message">{options.message}</div>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => settle(false)}>
            {options.cancelText ?? '取消'}
          </button>
          <button
            type="button"
            className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => settle(true)}
          >
            {options.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

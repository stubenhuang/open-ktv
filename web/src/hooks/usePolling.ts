import { useEffect, useRef } from 'react';

/**
 * 只在需要的时候轮询：active 为 false 时定时器根本不会建起来。
 * 用于「有伴奏正在转码 / 有作品正在混音」这类等待场景。
 */
export function usePolling(callback: () => void, intervalMs: number, active: boolean): void {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => savedCallback.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}

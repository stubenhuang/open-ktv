import { useCallback, useEffect, useRef, useState } from 'react';
import { listMicDevices, type MicDeviceInfo } from '../audio/engine';
import { errorMessage } from '../utils';

export type MicPermission = 'unknown' | 'requesting' | 'granted' | 'denied';

export interface UseMicDevicesResult {
  devices: MicDeviceInfo[];
  deviceId: string;
  permission: MicPermission;
  error: string | null;
  selectDevice: (deviceId: string) => void;
  /** 申请一次权限并列出设备 */
  request: () => Promise<void>;
}

/**
 * 麦克风权限与设备列表。
 * 浏览器只有在拿到一次麦克风权限之后，enumerateDevices 才会给出设备名，
 * 所以这里先 getUserMedia 打开再立刻关掉，纯粹为了「解锁」设备名。
 */
export function useMicDevices(): UseMicDevicesResult {
  const [devices, setDevices] = useState<MicDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [error, setError] = useState<string | null>(null);
  const deviceIdRef = useRef('');

  const refresh = useCallback(async () => {
    try {
      const list = await listMicDevices();
      setDevices(list);
      // 之前选中的设备可能被拔掉了，回退到第一个
      if (!list.some((device) => device.deviceId === deviceIdRef.current)) {
        const fallback = list[0]?.deviceId ?? '';
        deviceIdRef.current = fallback;
        setDeviceId(fallback);
      }
    } catch (err) {
      setError(errorMessage(err, '读取麦克风设备失败'));
    }
  }, []);

  const selectDevice = useCallback((nextId: string) => {
    deviceIdRef.current = nextId;
    setDeviceId(nextId);
  }, []);

  const request = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('denied');
      setError('这个浏览器不支持麦克风采集，请换 Chrome 或 Edge');
      return;
    }

    setPermission('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setPermission('granted');
      await refresh();
    } catch (err) {
      setPermission('denied');
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('麦克风权限被拒绝了。请点地址栏左侧的图标把麦克风权限改成「允许」，然后重试。');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('没有检测到任何麦克风设备，请插上耳麦后重试。');
      } else {
        setError(`打开麦克风失败：${errorMessage(err)}`);
      }
    }
  }, [refresh]);

  // 用户可能中途插拔设备
  useEffect(() => {
    const handler = () => {
      void refresh();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, [refresh]);

  return { devices, deviceId, permission, error, selectDevice, request };
}

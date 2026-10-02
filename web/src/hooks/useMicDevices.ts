import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listMicDevices, type MicDeviceInfo } from '../audio/engine';
import { errorMessage, isBuiltinMic } from '../utils';

export type MicPermission = 'unknown' | 'requesting' | 'granted' | 'denied';

export interface UseMicDevicesResult {
  /** 当前可选的设备（默认只有外置输入，见 showBuiltin） */
  devices: MicDeviceInfo[];
  deviceId: string;
  permission: MicPermission;
  error: string | null;
  /** 被隐藏的内置麦克风（名字一起带上：判据是猜的，界面要能让用户看明白藏了什么） */
  hiddenBuiltinLabels: string[];
  /** 是否临时把内置麦克风也放出来（没插外置时的退路，默认关） */
  showBuiltin: boolean;
  toggleBuiltin: () => void;
  selectDevice: (deviceId: string) => void;
  /** 申请一次权限并列出设备 */
  request: () => Promise<void>;
}

/**
 * 麦克风权限与设备列表。
 *
 * 浏览器只有在拿到一次麦克风权限之后，enumerateDevices 才会给出设备名，
 * 所以这里先 getUserMedia 打开再立刻关掉，纯粹为了「解锁」设备名。
 *
 * **只列外置输入**：MacBook 的内置麦克风在 Chrome 里往往就是「默认设备」，
 * 不放进列表就不会被误选（演唱要的是外置话筒的音质，也不想收进机身震动和风扇声）。
 * 内置设备一个不剩时不会静默回退到系统默认设备 —— 页面会提示插麦，
 * 并且留一个「临时显示内置麦克风」的开关，免得不插麦就完全没法唱。
 */
export function useMicDevices(): UseMicDevicesResult {
  const [allDevices, setAllDevices] = useState<MicDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const deviceIdRef = useRef('');

  const external = useMemo(
    () => allDevices.filter((device) => !isBuiltinMic(device.deviceId, device.label)),
    [allDevices],
  );
  const hiddenBuiltinLabels = useMemo(
    () => allDevices.filter((device) => isBuiltinMic(device.deviceId, device.label)).map((d) => d.label),
    [allDevices],
  );
  // 两个分支都返回稳定的引用，下游 effect 的依赖才是可靠的
  const devices = showBuiltin ? allDevices : external;

  const refresh = useCallback(async () => {
    try {
      setAllDevices(await listMicDevices());
    } catch (err) {
      setError(errorMessage(err, '读取麦克风设备失败'));
    }
  }, []);

  // 选中的设备可能被拔掉，也可能因为「显示内置」开关而被过滤掉：回退到第一个可选项。
  // 优先外置 —— 打开「显示内置」只是让它们可见，不该把已经选好的外置换掉；
  // 其次避开 Chrome 的 default 别名（它指向哪个物理设备说不准）。
  // 一个可选项都没有时留空字符串，调用方据此拒绝接入（不许回退到系统默认设备）。
  useEffect(() => {
    if (devices.some((device) => device.deviceId === deviceIdRef.current)) return;
    const fallback =
      external.find((device) => device.deviceId !== 'default')?.deviceId ??
      devices.find((device) => device.deviceId !== 'default')?.deviceId ??
      devices[0]?.deviceId ??
      '';
    deviceIdRef.current = fallback;
    setDeviceId(fallback);
  }, [devices, external]);

  const selectDevice = useCallback((nextId: string) => {
    deviceIdRef.current = nextId;
    setDeviceId(nextId);
  }, []);

  const toggleBuiltin = useCallback(() => {
    setShowBuiltin((value) => !value);
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

  return {
    devices,
    deviceId,
    permission,
    error,
    hiddenBuiltinLabels,
    showBuiltin,
    toggleBuiltin,
    selectDevice,
    request,
  };
}

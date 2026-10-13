import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MAX_RECORD_MS, MIN_RECORD_MS } from '../../../../shared/types';
import { api, trackMediaUrl, type TrackDetail } from '../../api';
import { LevelMeter } from '../../components/LevelMeter';
import { LyricsView } from '../../components/LyricsView';
import { isMicSupported } from '../../audio/engine';
import { MobileEngine } from '../../audio/mobileEngine';
import { useMicDevices } from '../../hooks/useMicDevices';
import { errorMessage, formatDuration, formatTimer } from '../../utils';

/** 录音阶段：idle = 待唱 / 收尾中；saving = 正在上传合成 */
type Phase = 'idle' | 'saving';

/* ------------------------------ 播放控制条 ------------------------------ */

/**
 * 手机端的播放控制：播放/暂停 + 进度 + 时间。
 *
 * 位置用 rAF **直写 DOM**（和 AudioPlayer / LevelMeter 同一套思路）——
 * 每秒 60 次重渲染在这里毫无必要。录音中禁用（拖动时间轴会破坏自动对齐）。
 */
function MobileTransport({
  mediaEl,
  disabled,
}: {
  mediaEl: HTMLMediaElement | null;
  disabled: boolean;
}) {
  const rangeRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    const element = mediaEl;
    if (!element) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('loadedmetadata', () => {
      if (totalRef.current) totalRef.current.textContent = formatDuration(element.duration);
    });
    return () => {
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
    };
  }, [mediaEl]);

  // 播放中：rAF 直写进度与时间
  useEffect(() => {
    if (!mediaEl || !playing || disabled) return;
    let frame = 0;
    const tick = () => {
      if (!draggingRef.current && rangeRef.current) {
        rangeRef.current.value = String(mediaEl.currentTime);
        if (currentRef.current) currentRef.current.textContent = formatDuration(mediaEl.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mediaEl, playing, disabled]);

  const toggle = () => {
    if (!mediaEl) return;
    if (mediaEl.paused) void mediaEl.play().catch(() => setPlaying(false));
    else mediaEl.pause();
  };

  const commitSeek = () => {
    draggingRef.current = false;
    const target = Number(rangeRef.current?.value ?? '0');
    if (mediaEl && Number.isFinite(target)) {
      mediaEl.currentTime = target;
      if (currentRef.current) currentRef.current.textContent = formatDuration(target);
    }
  };

  return (
    <div className="m-transport">
      <button
        type="button"
        className="m-play-btn"
        aria-label={playing ? '暂停' : '播放'}
        disabled={disabled || !mediaEl}
        onClick={toggle}
      >
        <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
      </button>
      <input
        ref={rangeRef}
        className="m-seek"
        type="range"
        min={0}
        max={mediaEl?.duration && Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0}
        step={0.1}
        defaultValue={0}
        disabled={disabled || !mediaEl}
        aria-label="播放进度"
        onChange={(event) => {
          draggingRef.current = true;
          if (currentRef.current) currentRef.current.textContent = formatDuration(Number(event.target.value));
        }}
        onPointerUp={commitSeek}
        onPointerCancel={commitSeek}
        onKeyUp={commitSeek}
        onBlur={commitSeek}
      />
      <span className="m-time mono">
        <span ref={currentRef}>{formatDuration(0)}</span>
        {' / '}
        <span ref={totalRef}>{formatDuration(mediaEl?.duration ?? null)}</span>
      </span>
    </div>
  );
}

/* -------------------------------- 演唱页 -------------------------------- */

export default function MobileSingPage() {
  const { trackId = '' } = useParams();
  const navigate = useNavigate();

  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [engine, setEngine] = useState<MobileEngine | null>(null);

  // 麦克风：与桌面同一套判据 —— 只列外置输入，内置默认隐藏，选不中就不给唱
  const mic = useMicDevices();

  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  /** 用来重跑麦克风接入 effect（换了设备 / 点了「重试」就 +1） */
  const [micAttempt, setMicAttempt] = useState(0);

  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);

  const elapsedRef = useRef(0);
  const handleStopRef = useRef<() => Promise<void>>(async () => {});

  /* ------------------------------- 加载伴奏 ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setTrack(null);
    setLoadError(null);
    api
      .getTrack(trackId)
      .then((result) => {
        if (!cancelled) setTrack(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err, '加载伴奏失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  /* -------------------------------- 音频引擎 -------------------------------- */

  const mediaCallbackRef = useCallback((node: HTMLVideoElement | HTMLAudioElement | null) => {
    setMediaEl(node);
  }, []);

  const readyTrackId = track?.status === 'ready' ? track.id : '';
  useEffect(() => {
    if (!mediaEl || !readyTrackId) return;
    const instance = new MobileEngine();
    setEngine(instance);
    return () => {
      instance.dispose();
      setEngine(null);
    };
  }, [mediaEl, readyTrackId]);

  /*
   * 麦克风接入：两步走。
   *  1) 进页面先要一次权限（useMicDevices.request）—— 不授权就拿不到设备名，
   *     下拉里只有 deviceId，用户没法挑；
   *  2) 选中某个外置设备后才真正接入音频图（engine.setMic(deviceId)）。
   *
   * 刻意**不在进页面时接入任何设备**：手机只有一个机身麦，默认接入的就是它，
   * 而外放伴奏会被机身麦收进混音。没选外置麦就不开麦，「开始演唱」也保持禁用。
   */
  // 权限只要一次：hook 每次渲染都返回新对象，用 ref 挡住重复触发（桌面 SingPage 同款）
  const micRequestedRef = useRef(false);
  useEffect(() => {
    if (micRequestedRef.current) return;
    micRequestedRef.current = true;
    void mic.request();
  }, [mic]);

  useEffect(() => {
    if (!engine || !mic.deviceId) {
      setMicReady(false);
      return;
    }
    let cancelled = false;
    setMicReady(false);
    engine
      .setMic(mic.deviceId)
      .then(() => {
        if (!cancelled) {
          setMicReady(true);
          setMicError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMicReady(false);
        setMicError(`接入麦克风失败：${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, mic.deviceId, micAttempt]);

  /* -------------------------------- 录音流程 -------------------------------- */

  const handleStop = useCallback(async () => {
    if (!engine || !track || !mediaEl) return;
    setPhase('saving');
    try {
      const result = await engine.stopRecording(mediaEl);
      setRecording(false);

      if (result.droppedRatio > 0.005) {
        setCaptureWarning(
          `这次录音有 ${(result.droppedRatio * 100).toFixed(1)}% 的时间片没采到，声音可能断断续续。` +
            '换个麦克风接口、或关掉别的占资源的程序再试。',
        );
      }

      const expectedSec = elapsedRef.current / 1000;
      if (expectedSec > 1.5 && result.durationSec < expectedSec * 0.6) {
        setPhase('idle');
        setActionError(
          `只采集到 ${result.durationSec.toFixed(1)} 秒音频，但录音持续了约 ${expectedSec.toFixed(1)} 秒。` +
            '多半是系统把后台音频收了，锁屏/切应用会这样。',
        );
        return;
      }

      if (result.durationSec * 1000 < MIN_RECORD_MS) {
        setPhase('idle');
        setActionError('录音太短了，至少唱满 1 秒再结束。');
        return;
      }

      const work = await api.createWork({
        vocal: result.blob,
        vocalFileName: 'vocal.wav',
        trackId: track.id,
        autoOffsetMs: result.autoOffsetMs,
        vocalDuration: result.durationSec,
      });
      navigate(`/m/work/${work.id}`);
    } catch (err) {
      setRecording(false);
      setPhase('idle');
      setActionError(`结束录音失败：${errorMessage(err)}`);
    }
  }, [engine, track, mediaEl, navigate]);

  handleStopRef.current = handleStop;

  const handleStart = useCallback(async () => {
    if (!engine || !mediaEl || !track) return;
    setActionError(null);
    setCaptureWarning(null);
    try {
      // resume 必须发生在用户手势里：iOS 的 AudioContext  otherwise 起不来
      await engine.resume();
      await engine.startRecording(mediaEl);
      elapsedRef.current = 0;
      setElapsedMs(0);
      setRecording(true);
    } catch (err) {
      setActionError(errorMessage(err, '开始演唱失败'));
    }
  }, [engine, mediaEl, track]);

  const handleAbandon = useCallback(() => {
    if (!engine || !mediaEl) return;
    engine.cancelRecording();
    mediaEl.pause();
    mediaEl.currentTime = 0;
    elapsedRef.current = 0;
    setRecording(false);
    setElapsedMs(0);
  }, [engine, mediaEl]);

  // 录音计时 + 到达上限自动收工
  useEffect(() => {
    if (!recording) return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const value = performance.now() - startedAt;
      elapsedRef.current = value;
      setElapsedMs(value);
      if (value >= MAX_RECORD_MS) void handleStopRef.current();
    }, 100);
    return () => window.clearInterval(timer);
  }, [recording]);

  // 伴奏放完自动结束录音
  useEffect(() => {
    if (!mediaEl || !recording) return;
    const onEnded = () => {
      void handleStopRef.current();
    };
    mediaEl.addEventListener('ended', onEnded);
    return () => mediaEl.removeEventListener('ended', onEnded);
  }, [mediaEl, recording]);

  // 录音中切到后台 / 关页面：手机浏览器会直接收走音频，先提醒一声
  useEffect(() => {
    if (!recording) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setActionError('录音中离开了这个页面，系统可能已经停止采集。建议重唱这一遍。');
      }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [recording]);

  /* --------------------------------- 渲染 --------------------------------- */

  const micSupported = isMicSupported();
  const secureContext =
    typeof window === 'undefined' ? true : Boolean(window.isSecureContext) &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  if (!micSupported || !secureContext) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            ‹ 返回
          </Link>
        </div>
        <div className="m-alert m-alert-error">
          {!secureContext
            ? '这个页面不是「安全上下文」（http + 局域网 IP），浏览器把麦克风禁用了。' +
              '请用桌面端二维码里的 https 地址重新打开；看到证书警告时点「高级 → 继续访问」。'
            : '这个浏览器缺少录音所需的能力（AudioWorklet / getUserMedia），请换新版 Chrome 或 Safari。'}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            ‹ 返回
          </Link>
        </div>
        <div className="m-alert m-alert-error">{loadError}</div>
      </div>
    );
  }

  if (!track) return <div className="m-page"><div className="m-empty">正在加载伴奏…</div></div>;

  if (track.status !== 'ready') {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            ‹ 返回
          </Link>
        </div>
        <div className="m-alert m-alert-warn">
          {track.status === 'processing'
            ? `这个伴奏还在转码中（${Math.round((track.progress ?? 0) * 100)}%），转好之后才能唱。`
            : `这个伴奏处理失败了：${track.error ?? '未知原因'}`}
        </div>
      </div>
    );
  }

  // 必须选中一个外置输入设备才给唱：不允许静默回退到机身麦克风
  const canStart =
    Boolean(engine) && mic.deviceId !== '' && micReady && !recording && phase === 'idle';
  const mediaUrl = trackMediaUrl(track.id);

  return (
    <div className={`m-page m-sing${recording ? ' m-sing-recording' : ''}`}>
      <div className="m-topbar">
        <Link className="m-back" to="/m">
          ‹ 返回
        </Link>
        <div className="m-topbar-title">
          <div className="m-topbar-name">{track.title}</div>
          <div className="m-topbar-sub">
            {track.artist ? `${track.artist} · ` : ''}
            {formatDuration(track.duration)}
            {track.kind === 'video' ? ' · 视频伴奏' : ''}
          </div>
        </div>
      </div>

      {actionError && <div className="m-alert m-alert-error">{actionError}</div>}
      {captureWarning && <div className="m-alert m-alert-warn">⚠️ {captureWarning}</div>}
      {mic.error && (
        <div className="m-alert m-alert-error">
          {mic.error}
          <button
            type="button"
            className="m-btn m-btn-ghost m-btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => void mic.request()}
          >
            重试授权
          </button>
        </div>
      )}
      {micError && (
        <div className="m-alert m-alert-error">
          {micError}
          <button
            type="button"
            className="m-btn m-btn-ghost m-btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => setMicAttempt((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}

      <div className="m-stage">
        {track.kind === 'video' ? (
          <video ref={mediaCallbackRef} src={mediaUrl} playsInline preload="auto" />
        ) : (
          <audio ref={mediaCallbackRef} src={mediaUrl} preload="auto" />
        )}

        {track.hasLyrics ? (
          <LyricsView
            lyrics={track.lyrics}
            lyricsOffsetMs={track.lyricsOffsetMs}
            mediaEl={mediaEl}
            canSeek={!recording}
            fullscreen
            mobile
            fit
          />
        ) : (
          <div className="m-stage-plain">
            <div className="m-disc" aria-hidden="true">
              <span>🎵</span>
            </div>
            <div className="m-stage-title">{track.title}</div>
            <div className="m-stage-sub">音频伴奏（无歌词）</div>
          </div>
        )}

        {recording && (
          <div className="m-rec-badge">
            <span className="m-rec-dot" />
            <span>录音中</span>
            <span className="mono">{formatTimer(elapsedMs)}</span>
          </div>
        )}
      </div>

      <div className="m-panel">
        {!recording && phase === 'idle' && (
          <>
            <MobileTransport mediaEl={mediaEl} disabled={false} />
            {/*
              输入设备：只列外置（机身麦默认隐藏，与桌面同口径）。
              手机只有一个机身麦，默认接入的必然是他 —— 外放伴奏会被收进混音，
              所以必须由用户显式选一个外置麦才能唱。
            */}
            <div className="m-field">
              <div className="m-field-label">
                <span>输入设备</span>
                {mic.permission !== 'granted' && <span className="m-faint">未授权</span>}
              </div>
              <select
                className="m-select"
                value={mic.deviceId}
                disabled={mic.permission !== 'granted' || mic.devices.length === 0}
                onChange={(event) => mic.selectDevice(event.target.value)}
              >
                {mic.devices.length === 0 && (
                  <option value="">
                    {mic.permission === 'granted' ? '（没有可用的外置输入）' : '（等待麦克风授权）'}
                  </option>
                )}
                {mic.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              {mic.hiddenBuiltinLabels.length > 0 &&
                (mic.showBuiltin ? (
                  <div className="m-notes">
                    已显示全部输入设备（含机身麦克风）。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      只看外置
                    </button>
                  </div>
                ) : mic.devices.length === 0 ? (
                  <div className="m-alert m-alert-warn" style={{ marginTop: 8 }}>
                    没检测到外置麦克风，已隐藏：{mic.hiddenBuiltinLabels.join('、')}。
                    插上 USB / Type-C / 3.5mm 麦克风或耳机麦后会出现在这里。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      显示全部设备
                    </button>
                  </div>
                ) : (
                  <div className="m-notes">
                    只列外置输入（已隐藏：{mic.hiddenBuiltinLabels.join('、')}）。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      显示全部设备
                    </button>
                  </div>
                ))}
            </div>

            <div className="m-mic-row">
              <span className="m-mic-label">输入电平</span>
              <LevelMeter engine={engine} active={micReady} />
              <span className="m-mic-hint">{micReady ? '对着麦克风说话试试' : '未接入'}</span>
            </div>
          </>
        )}

        {recording && (
          <div className="m-mic-row">
            <span className="m-mic-label">输入电平</span>
            <LevelMeter engine={engine} active />
            <span className="m-mic-hint mono">{formatTimer(elapsedMs)}</span>
          </div>
        )}

        {phase === 'saving' ? (
          <div className="m-saving">
            <span className="spin" />
            正在上传干声并合成…
          </div>
        ) : recording ? (
          <div className="m-rec-actions">
            <button type="button" className="m-btn m-btn-primary m-btn-record" onClick={() => void handleStop()}>
              完成录制
            </button>
            <button type="button" className="m-btn m-btn-ghost m-btn-record" onClick={handleAbandon}>
              取消录制
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-record"
            disabled={!canStart}
            onClick={() => void handleStart()}
          >
            开始演唱
          </button>
        )}

        {!recording && phase === 'idle' && (
          <p className="m-notes">
            🎧 建议戴耳机：手机外放伴奏会被麦克风收进去，混音里就是一串伴奏声。
            只录你的干声，伴奏不进录音文件；起唱前会自动留 0.15 秒静音用来对齐，不用手动调。
          </p>
        )}
      </div>
    </div>
  );
}

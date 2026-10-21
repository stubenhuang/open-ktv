//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MAX_RECORD_MS, MIN_RECORD_MS } from '../../../../shared/types';
import { api, trackMediaUrl, type TrackDetail } from '../../api';
import { LevelMeter } from '../../components/LevelMeter';
import { LyricsView } from '../../components/LyricsView';
import { PitchControl } from '../../components/PitchControl';
import { isMicSupported } from '../../audio/engine';
import { MobileEngine } from '../../audio/mobileEngine';
import { useMicDevices } from '../../hooks/useMicDevices';
import { usePolling } from '../../hooks/usePolling';
import { useI18n } from '../../i18n';
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
  const { t } = useI18n();
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
        aria-label={playing ? t('common.pause') : t('common.play')}
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
        aria-label={t('mobile.playback_progress')}
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
  const { t, fmt } = useI18n();

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
  /**
   * 伴奏地址的版本号：升降调会在**同一个 URL** 背后换文件（移调伴奏生成好之后），
   * 浏览器不会自己重新加载 —— 移调状态每变一次就涨一位。
   * （放在所有提前 return 之前：hooks 的顺序不能变）
   */
  const [mediaVersion, setMediaVersion] = useState(0);
  const bumpMediaVersion = useCallback(() => setMediaVersion((value) => value + 1), []);

  const elapsedRef = useRef(0);
  const handleStopRef = useRef<() => Promise<void>>(async () => {});

  /* ------------------------------- 加载伴奏 ------------------------------- */

  const loadTrack = useCallback((id: string) => {
    let cancelled = false;
    setLoadError(null);
    api
      .getTrack(id)
      .then((result) => {
        if (!cancelled) setTrack(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err, t('mobile.load_tracks_failed')));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setTrack(null);
    return loadTrack(trackId);
  }, [trackId, loadTrack]);

  // 移调生成中轮询：生成好之后要把媒体地址涨个版本号，手机才会重新拉移调后的伴奏
  usePolling(() => loadTrack(trackId), 1200, track?.pitchStatus === 'processing');

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
        setMicError(t('mobile.mic_connect_failed', { reason: errorMessage(err) }));
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
          t('mobile.capture.dropped_frames', { percent: fmt.percent(result.droppedRatio, 1) }),
        );
      }

      const expectedSec = elapsedRef.current / 1000;
      if (expectedSec > 1.5 && result.durationSec < expectedSec * 0.6) {
        setPhase('idle');
        setActionError(
          t('mobile.capture.short_capture', {
            captured: fmt.seconds(result.durationSec),
            expected: fmt.seconds(expectedSec),
          }),
        );
        return;
      }

      if (result.durationSec * 1000 < MIN_RECORD_MS) {
        setPhase('idle');
        setActionError(
          t('mobile.recording_too_short', { seconds: fmt.seconds(MIN_RECORD_MS / 1000) }),
        );
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
      setActionError(t('mobile.stop_failed', { reason: errorMessage(err) }));
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
      setActionError(errorMessage(err, t('mobile.start_sing_failed')));
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
        setActionError(t('mobile.backgrounded'));
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
            {t('mobile.back')}
          </Link>
        </div>
        <div className="m-alert m-alert-error">
          {!secureContext ? t('mobile.insecure_context') : t('mobile.unsupported_browser')}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            {t('mobile.back')}
          </Link>
        </div>
        <div className="m-alert m-alert-error">{loadError}</div>
      </div>
    );
  }

  if (!track) return <div className="m-page"><div className="m-empty">{t('mobile.loading_track')}</div></div>;

  if (track.status !== 'ready') {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            {t('mobile.back')}
          </Link>
        </div>
        <div className="m-alert m-alert-warn">
          {track.status === 'processing'
            ? t('mobile.track_processing', { percent: fmt.percent(track.progress ?? 0) })
            : t('mobile.track_failed', { reason: track.error ?? t('components.unknown_reason') })}
        </div>
      </div>
    );
  }

  // 必须选中一个外置输入设备才给唱：不允许静默回退到机身麦克风
  // 只有「正在移调」才禁唱：那几秒听到的还是原调，唱出来和成品对不上。
  // failed 不禁 —— 播放和混音都已回落原调，照常唱不串调（见 pitch.ts）。
  const canStart =
    Boolean(engine) &&
    mic.deviceId !== '' &&
    micReady &&
    !recording &&
    phase === 'idle' &&
    track.pitchStatus !== 'processing';
  /**
   * 伴奏地址的版本号：升降调会在同一个 URL 背后换文件（移调伴奏生成好之后），
   * 浏览器不会自己重新加载 —— 移调状态每变一次就涨一位（见上面的 state）。
   */
  const mediaUrl = trackMediaUrl(track.id, mediaVersion);

  return (
    <div className={`m-page m-sing${recording ? ' m-sing-recording' : ''}`}>
      <div className="m-topbar">
        <Link className="m-back" to="/m">
          {t('mobile.back')}
        </Link>
        <div className="m-topbar-title">
          <div className="m-topbar-name">{track.title}</div>
          <div className="m-topbar-sub">
            {track.artist ? `${track.artist} · ` : ''}
            {formatDuration(track.duration)}
            {track.kind === 'video' ? t('mobile.video_track') : ''}
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
            {t('mobile.retry_permission')}
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
            {t('common.retry')}
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
            <div className="m-stage-sub">{t('mobile.audio_only_no_lyrics')}</div>
          </div>
        )}

        {recording && (
          <div className="m-rec-badge">
            <span className="m-rec-dot" />
            <span>{t('mobile.recording')}</span>
            <span className="mono">{formatTimer(elapsedMs)}</span>
          </div>
        )}
      </div>

      <div className="m-panel">
        {!recording && phase === 'idle' && (
          <>
            <MobileTransport mediaEl={mediaEl} disabled={false} />

            {/*
              升降调：唱之前把伴奏的调定下来。服务端据此生成一份移调伴奏，
              耳机里 / 成品里混的全是那一份（见 server/src/pitch.ts）。
            */}
            <PitchControl
              track={track}
              compact
              disabled={recording || phase !== 'idle'}
              onStatusChange={bumpMediaVersion}
              onError={setActionError}
            />

            {/*
              输入设备：只列外置（机身麦默认隐藏，与桌面同口径）。
              手机只有一个机身麦，默认接入的必然是他 —— 外放伴奏会被收进混音，
              所以必须由用户显式选一个外置麦才能唱。
            */}
            <div className="m-field">
              <div className="m-field-label">
                <span>{t('mobile.mic.device')}</span>
                {mic.permission !== 'granted' && (
                  <span className="m-faint">{t('mobile.mic.not_granted')}</span>
                )}
              </div>
              <select
                className="m-select"
                value={mic.deviceId}
                disabled={mic.permission !== 'granted' || mic.devices.length === 0}
                onChange={(event) => mic.selectDevice(event.target.value)}
              >
                {mic.devices.length === 0 && (
                  <option value="">
                    {mic.permission === 'granted'
                      ? t('mobile.mic.no_external')
                      : t('mobile.mic.awaiting_permission')}
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
                    {t('mobile.mic.all_shown')}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('mobile.mic.external_only')}
                    </button>
                  </div>
                ) : mic.devices.length === 0 ? (
                  <div className="m-alert m-alert-warn" style={{ marginTop: 8 }}>
                    {t('mobile.mic.no_external_found', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('mobile.mic.show_all')}
                    </button>
                  </div>
                ) : (
                  <div className="m-notes">
                    {t('mobile.mic.external_only_note', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('mobile.mic.show_all')}
                    </button>
                  </div>
                ))}
            </div>

            <div className="m-mic-row">
              <span className="m-mic-label">{t('mobile.mic.level')}</span>
              <LevelMeter engine={engine} active={micReady} />
              <span className="m-mic-hint">
                {micReady ? t('mobile.mic.try_speaking') : t('mobile.mic.not_connected')}
              </span>
            </div>
          </>
        )}

        {recording && (
          <div className="m-mic-row">
            <span className="m-mic-label">{t('mobile.mic.level')}</span>
            <LevelMeter engine={engine} active />
            <span className="m-mic-hint mono">{formatTimer(elapsedMs)}</span>
          </div>
        )}

        {phase === 'saving' ? (
          <div className="m-saving">
            <span className="spin" />
            {t('mobile.uploading_mixing')}
          </div>
        ) : recording ? (
          <div className="m-rec-actions">
            <button type="button" className="m-btn m-btn-primary m-btn-record" onClick={() => void handleStop()}>
              {t('mobile.finish_recording')}
            </button>
            <button type="button" className="m-btn m-btn-ghost m-btn-record" onClick={handleAbandon}>
              {t('mobile.cancel_recording')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-record"
            disabled={!canStart}
            onClick={() => void handleStart()}
          >
            {t('mobile.start_singing')}
          </button>
        )}

        {/* 移调失败：不禁唱（这一版混的已经是原调），但得让人知道为什么没上新调 */}
        {!recording && phase === 'idle' && track.pitchStatus === 'failed' && (
          <p className="m-notes">
            {t('mobile.pitch_failed', {
              reason: track.pitchError ?? t('components.unknown_reason'),
            })}
          </p>
        )}

        {!recording && phase === 'idle' && (
          <p className="m-notes">{t('mobile.headphones_hint')}</p>
        )}
      </div>
    </div>
  );
}

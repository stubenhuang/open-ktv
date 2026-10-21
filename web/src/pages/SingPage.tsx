//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LRC_LIMITS, MAX_RECORD_MS, MIN_RECORD_MS } from '../../../shared/types';
import { api, trackMediaUrl, type TrackDetail } from '../api';
import { LevelMeter } from '../components/LevelMeter';
import { LyricsView } from '../components/LyricsView';
import { PitchControl } from '../components/PitchControl';
import { KtvEngine, isMicSupported } from '../audio/engine';
import { useMicDevices } from '../hooks/useMicDevices';
import { usePolling } from '../hooks/usePolling';
import { errorMessage, formatDuration, formatTimer } from '../utils';
import { useI18n } from '../i18n';

type Phase = 'idle' | 'saving';

export default function SingPage() {
  const { trackId = '' } = useParams();
  const navigate = useNavigate();
  const { t, fmt } = useI18n();

  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [engine, setEngine] = useState<KtvEngine | null>(null);

  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  /** 录音质量相关的提醒（不阻断流程，只在页面上提示） */
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);
  /**
   * 麦克风是否已经真正接进音频图。
   * 不能直接读引擎的内部状态 —— 那是个普通字段，接好了也不会触发 React 重渲染，
   * 界面会永远停在「正在接入麦克风…」。
   */
  const [micReady, setMicReady] = useState(false);

  const [accompVolume, setAccompVolume] = useState(0.9);
  const [micVolume, setMicVolume] = useState(0.65);
  const [micMonitoring, setMicMonitoring] = useState(true);
  /** 顶部耳机警告的「为什么？」是否展开（常驻会占掉小半屏，但说明不能删） */
  const [showWhy, setShowWhy] = useState(false);
  /**
   * 伴奏地址的版本号：升降调会在**同一个 URL** 背后换文件（移调伴奏生成好之后），
   * 浏览器不会自己重新加载 `<audio>` —— 移调状态每变一次就涨一位。
   * （必须放在所有提前 return 之前：hooks 的顺序不能变）
   */
  const [mediaVersion, setMediaVersion] = useState(0);
  const bumpMediaVersion = useCallback(() => setMediaVersion((value) => value + 1), []);

  const mic = useMicDevices();
  const requestedMic = useRef(false);
  const handleStopRef = useRef<() => Promise<void>>(async () => {});
  /**
   * 录音已进行的毫秒数。
   * handleStop 的 useCallback 依赖里没有 elapsedMs，直接读 state 会读到旧值，
   * 所以另用 ref 存一份给停止逻辑用。
   */
  const elapsedRef = useRef(0);

  /* ------------------------------- 加载伴奏 ------------------------------- */

  const loadTrack = useCallback(
    (id: string) => {
      let cancelled = false;
      setLoadError(null);
      api
        .getTrack(id)
        .then((result) => {
          if (!cancelled) setTrack(result);
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(errorMessage(err, t('sing.loadFailed')));
        });
      return () => {
        cancelled = true;
      };
    },
    [t],
  );

  useEffect(() => {
    setTrack(null);
    return loadTrack(trackId);
  }, [trackId, loadTrack]);

  /*
   * 移调生成中要轮询：生成好之后 pitchStatus 会变成 ready，页面得知道
   * （媒体地址要在那一刻涨版本号，浏览器才会重新拉移调后的那份伴奏）。
   */
  usePolling(() => loadTrack(trackId), 1200, track?.pitchStatus === 'processing');

  /* ------------------------------ 歌词对轴微调 ------------------------------ */

  /**
   * 歌词微调：本地立刻生效（滚动马上跟着变），停手 400ms 后才写库。
   * 每拖一格就发一次 PATCH 会把接口刷爆，而且拖动过程中每毫秒都在变。
   */
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(0);
  const persistTimer = useRef<number | null>(null);
  /** 只在本曲首次加载时同步一次，别让写库回包把用户拖到一半的值弹回去 */
  const lyricsSyncedTrackRef = useRef('');

  useEffect(() => {
    if (!track || lyricsSyncedTrackRef.current === track.id) return;
    lyricsSyncedTrackRef.current = track.id;
    setLyricsOffsetMs(track.lyricsOffsetMs);
  }, [track]);

  const applyLyricsOffset = useCallback(
    (next: number) => {
      setLyricsOffsetMs(next);
      if (!track) return;
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null;
        void api.updateTrack(track.id, { lyricsOffsetMs: next }).catch((err: unknown) => {
          setActionError(t('sing.lyricsOffsetSaveFailed', { reason: errorMessage(err) }));
        });
      }, 400);
    },
    [t, track],
  );

  // 卸载时丢掉待发的写库请求
  useEffect(
    () => () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  /* -------------------------------- 麦克风 -------------------------------- */

  useEffect(() => {
    if (requestedMic.current) return;
    requestedMic.current = true;
    if (!isMicSupported()) return;
    void mic.request();
  }, [mic]);

  /* ------------------------------- 音频引擎 ------------------------------- */

  const mediaCallbackRef = useCallback((node: HTMLVideoElement | HTMLAudioElement | null) => {
    setMediaEl(node);
  }, []);

  const readyTrackId = track?.status === 'ready' ? track.id : '';
  useEffect(() => {
    if (!mediaEl || !readyTrackId) return;
    const instance = new KtvEngine(mediaEl);
    setEngine(instance);
    return () => {
      instance.dispose();
      setEngine(null);
    };
  }, [mediaEl, readyTrackId]);

  useEffect(() => {
    // 等设备列表出来再接入：否则会先用「默认设备」接一次、拿到 deviceId 再接一次，
    // 两次 getUserMedia 互相 teardown，容易留下竞态。
    // 这里刻意要求 deviceId 非空：传 null/空会落到「系统默认设备」，也就是我们要避开的内置麦克风。
    if (!engine || mic.permission !== 'granted' || !mic.deviceId) {
      setMicReady(false);
      return;
    }

    let cancelled = false;
    setMicReady(false);

    engine
      .setMicDevice(mic.deviceId)
      .then(() => {
        if (!cancelled) setMicReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMicReady(false);
        setActionError(t('sing.micConnectFailed', { reason: errorMessage(err) }));
      });

    return () => {
      cancelled = true;
    };
  }, [engine, mic.permission, mic.deviceId]);

  useEffect(() => {
    engine?.setAccompVolume(accompVolume);
  }, [engine, accompVolume]);

  useEffect(() => {
    engine?.setMicMonitorVolume(micVolume);
  }, [engine, micVolume]);

  useEffect(() => {
    engine?.setMicMonitorEnabled(micMonitoring);
  }, [engine, micMonitoring]);

  /* -------------------------------- 录音流程 ------------------------------- */

  const handleStop = useCallback(async () => {
    if (!engine || !track) return;

    // 一按就进「收尾」态：stopRecording 要等 worklet flush（~80ms），
    // 这期间全屏层的按钮已经换成「正在合成…」，不会被重复点
    setPhase('saving');
    try {
      const result = await engine.stopRecording();
      setRecording(false);

      // 采集期间有整拍拿不到输入 → 设备在抖。这种丢音没法事后补，
      // 但必须让用户知道「不是自己唱的问题」。
      if (result.droppedRatio > 0.005) {
        setCaptureWarning(
          t('sing.capture.dropped', { percent: fmt.percent(result.droppedRatio, 1) }),
        );
      } else if (
        result.captureSettings.echoCancellation ||
        result.captureSettings.noiseSuppression
      ) {
        setCaptureWarning(t('sing.capture.echoCancellation'));
      }

      // 音频设备中途挂掉时，采集到的数据会远少于实际录制时长。
      // 这种情况必须单独报出来 —— 否则用户只会看到「录音太短」，完全摸不着头脑。
      const expectedSec = elapsedRef.current / 1000;
      if (expectedSec > 1.5 && result.durationSec < expectedSec * 0.6) {
        const contextState = engine.context.state;
        setPhase('idle');
        setActionError(
          t('sing.capture.shortfall', {
            captured: fmt.seconds(result.durationSec),
            expected: fmt.seconds(expectedSec),
            state: t(`sing.audioContext.${contextState}`),
          }),
        );
        return;
      }

      if (result.durationSec * 1000 < MIN_RECORD_MS) {
        setPhase('idle');
        setActionError(
          t('sing.recording.tooShort', { seconds: fmt.seconds(MIN_RECORD_MS / 1000) }),
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
      navigate(`/works/${work.id}`);
    } catch (err) {
      setRecording(false);
      setPhase('idle');
      setActionError(t('sing.stopFailed', { reason: errorMessage(err) }));
    }
  }, [engine, track, navigate, t, fmt]);

  handleStopRef.current = handleStop;

  const handleStart = useCallback(async () => {
    if (!engine || !track) return;
    setActionError(null);
    setCaptureWarning(null);
    try {
      await engine.resume();
      await engine.startRecording();
      elapsedRef.current = 0;
      setElapsedMs(0);
      setRecording(true);
    } catch (err) {
      setActionError(errorMessage(err, t('sing.startFailed')));
    }
  }, [engine, track, t]);

  const handleAbandon = useCallback(() => {
    if (!engine) return;
    engine.cancelRecording();
    elapsedRef.current = 0;
    setRecording(false);
    setElapsedMs(0);
  }, [engine]);

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

  // 录音中关掉页面要拦一下
  useEffect(() => {
    if (!recording) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [recording]);

  /* --------------------------------- 渲染 --------------------------------- */

  if (!isMicSupported()) {
    return (
      <div>
        <div className="alert alert-error">
          {t('sing.unsupported')}
        </div>
        <Link className="btn" to="/">
          {t('sing.backToLibrary')}
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <div className="alert alert-error">{loadError}</div>
        <Link className="btn" to="/">
          {t('sing.backToLibrary')}
        </Link>
      </div>
    );
  }

  if (!track) return <div className="empty-state">{t('sing.loadingTrack')}</div>;

  if (track.status !== 'ready') {
    return (
      <div>
        <div className="alert alert-warn">
          {track.status === 'processing'
            ? t('sing.track.processing', { percent: fmt.percent(track.progress ?? 0) })
            : t('sing.track.failed', { reason: track.error ?? t('sing.unknownReason') })}
        </div>
        <Link className="btn" to="/">
          {t('sing.backToLibrary')}
        </Link>
      </div>
    );
  }

  // 只有「正在生成」才禁唱：那几秒播放/试听听到的还是原调，照这个调唱出来，
  // 和成品里混的那一档对不上。
  // failed 不禁 —— 生成失败时播放和混音都已安全回落原调（见 pitch.ts 的
  // playableFileFor / mixAccompFileFor），照常唱不会串调；禁死只会把用户
  // 摁在「按钮灰着、提示却说可以点」的死局里，解脱口只剩重试或拖回原调。
  const canStart =
    Boolean(engine) &&
    micReady &&
    !recording &&
    phase === 'idle' &&
    track?.pitchStatus !== 'processing';
  const mediaUrl = trackMediaUrl(track.id, mediaVersion);
  /**
   * 录音中（含收尾合成）进入全屏歌词模式。
   * 只是把舞台用 CSS 提到视口大小 —— <video>/<audio> 元素原地不动：
   * MediaElementSource 绑在 DOM 节点上，搬家会重建音频图、打断伴奏。
   */
  const fullscreen = recording || phase === 'saving';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{track.title}</h1>
          <p className="page-sub">
            {track.artist ? `${track.artist} · ` : ''}
            {formatDuration(track.duration)} ·{' '}
            {track.kind === 'video' ? t('sing.trackKind.video') : t('sing.trackKind.audio')}
          </p>
        </div>
        <Link className="btn btn-ghost" to="/">
          {t('sing.backToLibrary')}
        </Link>
      </div>

      {/*
        耳机警告：第一行常驻（这是真会毁掉录音的一条），原因收进「为什么？」。
        整段铺开会从小半屏开始，把舞台和开始按钮全顶到下面去。
      */}
      <div className="alert alert-warn">
        🎧 {t('sing.headphones.warning')}
        <button type="button" className="link-btn" onClick={() => setShowWhy((value) => !value)}>
          {showWhy ? t('common.collapse') : t('sing.headphones.why')}
        </button>
        {showWhy && (
          <div className="sing-why">
            {t('sing.headphones.reason')}
          </div>
        )}
      </div>

      {actionError && <div className="alert alert-error" role="alert">{actionError}</div>}

      {captureWarning && <div className="alert alert-warn" role="alert">⚠️ {captureWarning}</div>}

      {mic.error && (
        <div className="alert alert-error" role="alert">
          {mic.error}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => void mic.request()}
          >
            {t('sing.mic.retryAuth')}
          </button>
        </div>
      )}

      <div className="sing-grid">
        <div>
          <div className={`stage${fullscreen ? ' stage-fullscreen' : ''}`}>
            {track.kind === 'video' ? (
              <video
                ref={mediaCallbackRef}
                src={mediaUrl}
                controls={!recording}
                playsInline
                preload="auto"
              />
            ) : (
              <audio
                ref={mediaCallbackRef}
                src={mediaUrl}
                controls={!recording}
                preload="auto"
                style={{ position: 'absolute', left: 16, right: 16, bottom: 12 }}
              />
            )}

            {/* 有歌词就跟唱（视频伴奏叠在画面上，音频伴奏直接铺满舞台） */}
            {track.hasLyrics ? (
              <LyricsView
                lyrics={track.lyrics}
                lyricsOffsetMs={lyricsOffsetMs}
                mediaEl={mediaEl}
                canSeek={!recording}
                overlay={track.kind === 'video' && !fullscreen}
                fullscreen={fullscreen}
              />
            ) : track.kind !== 'video' ? (
              /* 音频伴奏的「舞台」：慢转的唱片 + 歌名，比一枚大 emoji 有生命力 */
              <div className="stage-audio-visual">
                <div className="stage-disc-wrap">
                  <div className="stage-disc" />
                  <span className="stage-disc-note" aria-hidden="true">
                    🎵
                  </span>
                </div>
                <div className="stage-audio-title">{track.title}</div>
                <div className="small faint">{t('sing.stage.audioOnly')}</div>
              </div>
            ) : null}

            {/* 全屏录制层：大字逐字歌词 + 右上角的「完成录制 / 取消录制」 */}
            {fullscreen && (
              <>
                {/* 视频垫在渐变下，白字歌词在任何画面上都看得清 */}
                {track.kind === 'video' && <div className="stage-fs-scrim" />}
                <div className="stage-fs-ui">
                  <div className="stage-fs-info">
                    <div className="stage-fs-title">{track.title}</div>
                    <div className="stage-fs-status">
                      {phase === 'saving' ? (
                        <>
                          <span className="spin" />
                          {t('sing.recording.mixing')}
                        </>
                      ) : (
                        <>
                          <span className="rec-dot" />
                          <span>{t('sing.recording.active')}</span>
                          <span className="mono">{formatTimer(elapsedMs)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="stage-fs-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-lg"
                      disabled={phase !== 'idle'}
                      onClick={() => void handleStop()}
                    >
                      {phase === 'saving' ? (
                        <>
                          <span className="spin" />
                          {t('sing.recording.mixing')}
                        </>
                      ) : (
                        t('sing.recording.finish')
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn-lg stage-fs-cancel"
                      disabled={phase !== 'idle'}
                      onClick={handleAbandon}
                    >
                      {t('sing.recording.cancel')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 全屏期操作都在右上角，这里只留待唱状态的开始按钮 */}
          {!fullscreen && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="record-bar">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={!canStart}
                  onClick={() => void handleStart()}
                >
                  {t('sing.start')}
                </button>
                <span className="muted small">
                  {track.pitchStatus === 'processing'
                    ? t('sing.hint.pitchProcessing')
                    : track.pitchStatus === 'failed'
                      ? // 不禁唱，但要说明白：这一版混的是原调，和新调对不上
                        t('sing.hint.pitchFailed', {
                          reason: track.pitchError ?? t('sing.unknownReason'),
                        })
                      : engine
                        ? mic.permission !== 'granted'
                          ? t('sing.hint.micPermission')
                          : mic.devices.length === 0
                            ? t('sing.hint.noExternalMic')
                            : micReady
                              ? t('sing.hint.ready', { action: t('sing.start') })
                              : t('sing.hint.micConnecting')
                        : t('sing.hint.audioPreparing')}
                </span>
              </div>
            </div>
          )}

          {/*
            录音说明挂在左列底部（原来是右列最后一张卡）：右列四张控件卡
            几乎比左列高出一倍，说明卡搬过来正好把左列下方的空白填掉，
            两列高度也就齐了 —— 它本来就跟「开始演唱」是一件事的注脚。
          */}
          <div className="card small muted" style={{ marginTop: 16 }}>
            <div className="panel-card-title">📋 {t('sing.notes.title')}</div>
            <ul className="record-notes">
              <li>{t('sing.notes.dryOnly')}</li>
              <li>{t('sing.notes.autoMix')}</li>
              <li>{t('sing.notes.effects')}</li>
              <li>{t('sing.notes.alignment')}</li>
            </ul>
          </div>
        </div>

        {/*
          右侧控制面板按「开唱前后要弄好的事」分四卡：
          麦克风（有没有声音）→ 耳机监听（听到什么）→ 升降调（定调）→ 歌词（字幕对不对）。
        */}
        <div className="control-panel">
          <div className="card">
            <div className="panel-card-title">🎙 {t('sing.mic.title')}</div>
            <div className="field">
              <div className="field-label">
                <span>{t('sing.mic.device')}</span>
                {mic.permission !== 'granted' && (
                  <span className="faint small">{t('sing.mic.unauthorized')}</span>
                )}
              </div>
              <select
                className="select-input"
                value={mic.deviceId}
                disabled={mic.permission !== 'granted' || recording || mic.devices.length === 0}
                onChange={(event) => mic.selectDevice(event.target.value)}
              >
                {mic.devices.length === 0 && (
                  <option value="">
                    {mic.permission === 'granted'
                      ? t('sing.mic.noExternalInput')
                      : t('sing.mic.waitingPermission')}
                  </option>
                )}
                {mic.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>

              {/* 只列外置输入：内置麦克风被藏起来了，这里说清它们去哪了，并留一个「全都放出来」的开关
                  （判据是设备名，所以把藏掉的名字也列出来 —— 万一认错了用户一眼能看出来并自己救回来） */}
              {mic.hiddenBuiltinLabels.length > 0 &&
                (mic.showBuiltin ? (
                  <div className="small faint">
                    {t('sing.mic.showingAll')}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('sing.mic.externalOnly')}
                    </button>
                  </div>
                ) : mic.devices.length === 0 ? (
                  <div className="alert alert-warn" style={{ marginTop: 8 }}>
                    {t('sing.mic.noExternalDetected', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('sing.mic.showAll')}
                    </button>
                  </div>
                ) : (
                  <div className="small faint">
                    {t('sing.mic.externalOnlyHint', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('sing.mic.showAll')}
                    </button>
                  </div>
                ))}
              <div className="field-label" style={{ marginTop: 6 }}>
                <span>{t('sing.mic.level')}</span>
                <span className="faint small">
                  {micReady ? t('sing.mic.speakToTest') : t('sing.mic.notConnected')}
                </span>
              </div>
              <LevelMeter engine={engine} active={micReady} />
            </div>
          </div>

          <div className="card">
            <div className="panel-card-title">🎧 {t('sing.monitor.title')}</div>
            <div className="field">
              <div className="field-label">
                <span>{t('sing.monitor.accompVolume')}</span>
                <span className="field-value">{fmt.percent(accompVolume)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={accompVolume}
                onChange={(event) => setAccompVolume(Number(event.target.value))}
              />
              <div className="small faint">{t('sing.monitor.accompHint')}</div>
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <div className="field-label">
                <span>{t('sing.monitor.micMonitor')}</span>
                <span className="field-value">
                  {micMonitoring ? fmt.percent(micVolume) : t('common.disabled')}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={micVolume}
                disabled={!micMonitoring}
                onChange={(event) => setMicVolume(Number(event.target.value))}
              />
              <label className="row small muted" style={{ gap: 7, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={micMonitoring}
                  onChange={(event) => setMicMonitoring(event.target.checked)}
                />
                {t('sing.monitor.hearMyself')}
              </label>
            </div>
          </div>

          {/*
             * 升降调：唱之前把伴奏的调定下来。服务端据此生成一份移调伴奏，
             * 耳机里 / 试听里 / 成品里混的全是那一份（见 server/src/pitch.ts）。
             * 放在「耳机监听」前面：它是开唱前要弄好的事，和选麦克风同一类。
             */}
          <div className="card">
            <div className="panel-card-title">🎚 {t('sing.pitch.title')}</div>
            <PitchControl
              track={track}
              disabled={recording || phase !== 'idle'}
              onStatusChange={bumpMediaVersion}
              onError={(message) => setActionError(message)}
            />
          </div>

          {track.hasLyrics && (
            <div className="card">
              <div className="panel-card-title">📄 {t('sing.lyrics.title')}</div>
              <div className="field">
                <div className="field-label">
                  <span>{t('sing.lyrics.offset')}</span>
                  <span className="field-value">
                    {fmt.signed(lyricsOffsetMs)} {t('common.unit.millisecond')}
                  </span>
                </div>
                <input
                  type="range"
                  min={LRC_LIMITS.offsetMs.min}
                  max={LRC_LIMITS.offsetMs.max}
                  step={LRC_LIMITS.offsetMs.step}
                  value={lyricsOffsetMs}
                  onChange={(event) => applyLyricsOffset(Number(event.target.value))}
                />
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                  <span className="small faint">
                    {t('sing.lyrics.offsetHint')}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={lyricsOffsetMs === 0}
                    onClick={() => applyLyricsOffset(0)}
                  >
                    {t('sing.lyrics.offsetReset')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

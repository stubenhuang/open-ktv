//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MAX_RECORD_MS, RETAKE_LIMITS } from '../../../shared/types';
import { formatLrcTimestamp, lrcDisplayTimeMs, parseLrc } from '../../../shared/lrc';
import { segmentSpliceOffsetSec } from '../../../shared/mix';
import { encodeWavBlob } from '../../../shared/wav';
import {
  api,
  trackMediaUrl,
  workAudioUrl,
  workVocalUrl,
  type TrackDetail,
  type WorkListItem,
} from '../api';
import { LevelMeter } from '../components/LevelMeter';
import { LyricsView } from '../components/LyricsView';
import { KtvEngine, isMicSupported } from '../audio/engine';
import { useI18n } from '../i18n';
import { useMicDevices } from '../hooks/useMicDevices';
import { usePolling } from '../hooks/usePolling';
import { errorMessage, formatDuration, formatTimer } from '../utils';

/**
 * 分段重录页（/works/:workId/retake，只桌面端）。
 *
 * 流程：选干声轴上的一段 [开始, 结束) → 戴耳机开录（伴奏从「片段开始 − 3 秒」
 * 响起，给找拍；过「片段结束 + 1 秒」自动停）→ 裁出目标窗口上传 → 服务端拼进
 * 原干声并自动重新混音 → 回作品页等新成品。
 *
 * 对齐数学（shared/mix.ts 的 segmentSpliceOffsetSec）：
 * 原录音「歌内位置 x ↔ 干声时间 x + G/1000」（G = 作品 autoOffsetMs）。
 * 重录 seek 到歌内 P 再起录、起播间隔重新量得 G_new，新录音 t' 时刻的声音
 * 应落在干声时间 t' + P + (G − G_new)/1000。所以裁窗口 = 目标区间整体
 * 减去这个偏移；P 必须用**实际** seek 位置（靠近歌头会被钳到 0）。
 *
 * 干声总时长不变（服务端按目标长度拼），所以作品的 autoOffsetMs、伴奏时间轴
 * 原样成立，用户微调的对齐也不用重设。
 */

/** 阶段：pick = 选段待录；recording = 全屏歌词录制中；splicing = 上传拼接中 */
type Phase = 'pick' | 'recording' | 'splicing';

/** 片段时长下限（秒）：与 shared 的 RETAKE_LIMITS.minSegmentSec 同一口径 */
const MIN_SEGMENT_SEC = RETAKE_LIMITS.minSegmentSec;

export default function RetakePage() {
  const { workId = '' } = useParams();
  const navigate = useNavigate();
  const { t, fmt } = useI18n();

  const [work, setWork] = useState<WorkListItem | null>(null);
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [engine, setEngine] = useState<KtvEngine | null>(null);

  const [phase, setPhase] = useState<Phase>('pick');
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 录音质量相关的提醒（不阻断流程，只在页面上提示） */
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);
  const [micReady, setMicReady] = useState(false);
  /** 「试听这一段」是否在播 */
  const [previewing, setPreviewing] = useState(false);
  /**
   * 伴奏地址的版本号：升降调会在**同一个 URL** 背后换文件（移调伴奏生成好之后），
   * 浏览器不会自己重新加载 `<audio>` —— 移调状态每变一次就涨一位。
   * （放在所有提前 return 之前：hooks 的顺序不能变）
   */
  const [mediaVersion, setMediaVersion] = useState(0);
  const bumpMediaVersion = useCallback(() => setMediaVersion((value) => value + 1), []);

  const mic = useMicDevices();
  const requestedMic = useRef(false);
  const handleStopRef = useRef<() => Promise<void>>(async () => {});
  const elapsedRef = useRef(0);
  const previewElRef = useRef<HTMLAudioElement | null>(null);
  /**
   * 收尾 in-flight。自动停和手动点「完成重录」可能撞在同一个毫秒里
   * （轮询回调 vs 点击事件），引擎的 stopRecording 第二次调用会直接抛。
   * 用 ref 而不是 phase：phase 是异步 state，点击后到 setPhase 之间有个空档。
   */
  const stoppingRef = useRef(false);

  /* ------------------------------- 加载作品 ------------------------------- */

  const loadWork = useCallback(() => {
    let cancelled = false;
    setWork(null);
    setTrack(null);
    setLoadError(null);

    void (async () => {
      try {
        const loaded = await api.getWork(workId);
        if (cancelled) return;
        setWork(loaded);
        if (loaded.trackId) {
          const loadedTrack = await api.getTrack(loaded.trackId);
          if (!cancelled) setTrack(loadedTrack);
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, t('retake.load_failed')));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workId]);

  useEffect(() => loadWork(), [loadWork]);

  /*
   * 伴奏正在移调时轮询：重录听到的伴奏必须和当初录这条干声时是同一份
   * （否则新片段和旧片段的调对不上），所以移调没生成好就不给开录。
   */
  usePolling(() => loadWork(), 1200, track?.pitchStatus === 'processing');

  // 移调状态变化 → 媒体地址涨版本号（同一个 URL 背后换了文件，浏览器不会自己重载）
  const lastPitchStatusRef = useRef(track?.pitchStatus);
  useEffect(() => {
    if (!track || lastPitchStatusRef.current === track.pitchStatus) return;
    lastPitchStatusRef.current = track.pitchStatus;
    bumpMediaVersion();
  }, [track, bumpMediaVersion]);

  /* ------------------------------ 默认选区段 ------------------------------ */

  const rangeInitRef = useRef('');
  useEffect(() => {
    if (!work || rangeInitRef.current === work.id) return;
    rangeInitRef.current = work.id;
    // 默认取开头 30 秒：进来多半是要改某一句话，滑块和歌词点选都在手边，
    // 给一个「不大不小」的起点比空着或整条更省事
    setStartSec(0);
    setEndSec(Math.min(work.vocalDuration, 30));
  }, [work]);

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
    // 两次 getUserMedia 互相 teardown，容易留下竞态（同 SingPage）。
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
        setActionError(t('retake.mic_connect_failed', { reason: errorMessage(err) }));
      });

    return () => {
      cancelled = true;
    };
  }, [engine, mic.permission, mic.deviceId]);

  /* ------------------------------ 选段辅助逻辑 ----------------------------- */

  const duration = work?.vocalDuration ?? 0;

  /** 设开始时间：与结束至少差一个最小片段，结束时不够就把结束一起推 */
  const setRangeStart = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(0, Math.min(duration - MIN_SEGMENT_SEC, value));
      setStartSec(clamped);
      setEndSec((prev) => Math.min(duration, Math.max(clamped + MIN_SEGMENT_SEC, prev)));
    },
    [duration],
  );

  /** 设结束时间：与开始至少差一个最小片段，开始时不够就把开始一起收 */
  const setRangeEnd = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(MIN_SEGMENT_SEC, Math.min(duration, value));
      setEndSec(clamped);
      setStartSec((prev) => Math.max(0, Math.min(clamped - MIN_SEGMENT_SEC, prev)));
    },
    [duration],
  );

  /**
   * 歌词行在**干声轴**上的起止（秒）。
   *
   * 歌词时间是伴奏轴：行时刻要先过一遍 lrcDisplayTimeMs（[offset:] 标签 +
   * 用户对轴微调）才是它真正的歌曲位置，再加 G/1000 换成干声轴
   * （「歌内位置 x ↔ 干声时间 x + G/1000」）。
   * 「起」取本行起点，「止」取下一行起点（末行借干声总长）—— 点到哪行，
   * 替换范围就正好盖住哪行整句。
   */
  const lyricRanges = useMemo(() => {
    if (!track?.lyrics || !work) return [];
    const doc = parseLrc(track.lyrics);
    const gapSec = work.autoOffsetMs / 1000;
    return doc.lines.map((line, index) => {
      const lineSongMs = lrcDisplayTimeMs(line.timeMs, doc.offsetMs, track.lyricsOffsetMs);
      const next = doc.lines[index + 1];
      const endSongMs =
        next === undefined
          ? work.vocalDuration * 1000
          : lrcDisplayTimeMs(next.timeMs, doc.offsetMs, track.lyricsOffsetMs);
      return {
        timeMs: line.timeMs,
        text: line.text,
        startSec: Math.max(0, Math.min(work.vocalDuration, lineSongMs / 1000 + gapSec)),
        endSec: Math.max(0, Math.min(work.vocalDuration, endSongMs / 1000 + gapSec)),
      };
    });
  }, [track, work]);

  /* ------------------------- 重录的 seek / 自动停计划 ------------------------ */

  const seekPlan = useMemo(() => {
    if (!work || !track?.duration) return null;
    const gapSec = work.autoOffsetMs / 1000;
    const songStart = startSec - gapSec;
    const songEnd = endSec - gapSec;
    return {
      /** 实际 seek 到的歌内位置（钳在 [0, 伴奏时长]）—— 算偏移必须用实际值 */
      seekPos: Math.max(0, Math.min(track.duration, songStart - RETAKE_LIMITS.leadInSec)),
      /** 伴奏到这个歌内位置就自动停录 */
      stopAtSongPos: songEnd + RETAKE_LIMITS.tailSec,
      songEnd,
    };
  }, [work, track, startSec, endSec]);

  /** 片段末端超出伴奏长度：那段没有伴奏可跟，重录无从对齐 */
  const beyondTrack =
    seekPlan !== null && track !== null && seekPlan.songEnd > (track.duration ?? 0) + 0.25;

  const canRecord =
    Boolean(engine) &&
    micReady &&
    phase === 'pick' &&
    Boolean(work?.trackId) &&
    track?.status === 'ready' &&
    // 伴奏正在移调：这时播放/听到的还是原调，重录出来和旧片段的调对不上。
    // failed 不挡 —— 那意味着这一版混的已经是原调（pitch.ts 的 mixAccompFileFor
    // 在移调文件不在位时回落母带），旧片段也是照原调录的，正好对得上。
    track?.pitchStatus !== 'processing' &&
    Boolean(track?.duration) &&
    work?.status !== 'mixing' &&
    !beyondTrack;

  /* -------------------------------- 试听一段 -------------------------------- */

  // 成品就绪时试听混音（用户当初就是照它判断「这句唱砸了」）；否则退到干声
  const previewUrl = work
    ? work.status === 'ready'
      ? workAudioUrl(work.id, work.updatedAt)
      : workVocalUrl(work.id)
    : '';

  const togglePreview = useCallback(() => {
    const element = previewElRef.current;
    if (!element) return;
    if (previewing) {
      element.pause();
      setPreviewing(false);
      return;
    }
    // 早 1 秒起播给上下文，播到片段结束 + 1 秒停
    element.currentTime = Math.max(0, startSec - 1);
    void element
      .play()
      .then(() => setPreviewing(true))
      .catch(() => setPreviewing(false));
  }, [previewing, startSec]);

  useEffect(() => {
    const element = previewElRef.current;
    if (!element || !previewing) return;
    const stopAt = endSec + 1;
    const onTime = () => {
      if (element.currentTime >= stopAt) {
        element.pause();
        setPreviewing(false);
      }
    };
    element.addEventListener('timeupdate', onTime);
    return () => element.removeEventListener('timeupdate', onTime);
  }, [previewing, endSec]);

  /* -------------------------------- 录音流程 ------------------------------- */

  const handleStop = useCallback(async () => {
    if (!engine || !work || !seekPlan) return;
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    // 一按就进「拼接中」：stopRecording 要等 worklet flush（~80ms），
    // 这期间全屏层的按钮已经换成「正在拼接…」，不会被重复点
    setPhase('splicing');
    try {
      const result = await engine.stopRecording();

      // 采集告警与整首录音同一套判据（丢拍 / 驱动硬开处理）
      if (result.droppedRatio > 0.005) {
        setCaptureWarning(
          t('retake.capture.dropped_frames', { percent: fmt.percent(result.droppedRatio, 1) }),
        );
      } else if (
        result.captureSettings.echoCancellation ||
        result.captureSettings.noiseSuppression
      ) {
        setCaptureWarning(t('retake.capture.forced_processing'));
      }

      // 裁窗口：目标干声区间 [startSec, endSec) 在新录音里的位置。
      // 偏移用实际 seek 位置 + 这次实测的起播间隔算（shared/mix.ts）。
      const spliceOffsetSec = segmentSpliceOffsetSec(
        seekPlan.seekPos,
        work.autoOffsetMs,
        result.autoOffsetMs,
      );
      const windowStartSec = startSec - spliceOffsetSec;
      const windowEndSec = endSec - spliceOffsetSec;
      const sampleRate = result.sampleRate;
      const from = Math.round(windowStartSec * sampleRate);
      const to = Math.round(windowEndSec * sampleRate);

      // 起播间隔测出异常值（远大于原录音的 G）时，窗口起点会跑到录音之前
      if (windowStartSec < -0.05) {
        setPhase('pick');
        setActionError(t('retake.offset_not_measured'));
        return;
      }
      // 录音在片段结束前就停了（手动早点 / 设备中途挂掉）：补静音不如明说
      if (to > result.samples.length) {
        setPhase('pick');
        setActionError(
          t('retake.recording_too_short_for_range', {
            duration: formatDuration(result.durationSec),
          }),
        );
        return;
      }
      if (to - Math.max(0, from) < sampleRate * MIN_SEGMENT_SEC) {
        setPhase('pick');
        setActionError(t('retake.segment_too_short'));
        return;
      }

      const segment = encodeWavBlob(
        result.samples.subarray(Math.max(0, from), to),
        sampleRate,
      );
      await api.retakeWork(work.id, { vocal: segment, startSec, endSec });
      // 服务端已拼接并重新入队混音；详情页会轮询等新成品
      navigate(`/works/${work.id}`);
    } catch (err) {
      setPhase('pick');
      setActionError(errorMessage(err, t('retake.failed')));
    } finally {
      // 失败时放行，让用户改完再来一次；成功时已经导航走，无所谓
      stoppingRef.current = false;
    }
  }, [engine, work, seekPlan, startSec, endSec, navigate]);

  handleStopRef.current = handleStop;

  const handleStart = useCallback(async () => {
    if (!engine || !seekPlan) return;
    setActionError(null);
    setCaptureWarning(null);
    try {
      await engine.resume();
      await engine.startRecording({
        seekTo: seekPlan.seekPos,
        stopAtSongPos: seekPlan.stopAtSongPos,
        // 过了「片段结束 + 尾量」自动收工，走与「完成重录」完全相同的收尾
        onAutoStop: () => {
          void handleStopRef.current();
        },
      });
      elapsedRef.current = 0;
      setElapsedMs(0);
      setPhase('recording');
    } catch (err) {
      setActionError(errorMessage(err, t('retake.start_failed')));
    }
  }, [engine, seekPlan]);

  const handleAbandon = useCallback(() => {
    if (!engine) return;
    engine.cancelRecording();
    elapsedRef.current = 0;
    setElapsedMs(0);
    setPhase('pick');
  }, [engine]);

  // 录音计时 + 到达上限自动收工
  useEffect(() => {
    if (phase !== 'recording') return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const value = performance.now() - startedAt;
      elapsedRef.current = value;
      setElapsedMs(value);
      if (value >= MAX_RECORD_MS) void handleStopRef.current();
    }, 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  // 伴奏放完自动结束（片段就在歌尾附近时会发生）
  useEffect(() => {
    if (!mediaEl || phase !== 'recording') return;
    const onEnded = () => {
      void handleStopRef.current();
    };
    mediaEl.addEventListener('ended', onEnded);
    return () => mediaEl.removeEventListener('ended', onEnded);
  }, [mediaEl, phase]);

  // 录音中关掉页面要拦一下
  useEffect(() => {
    if (phase !== 'recording') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  /* --------------------------------- 渲染 --------------------------------- */

  if (!isMicSupported()) {
    return (
      <div>
        <div className="alert alert-error">{t('retake.unsupported_browser')}</div>
        <Link className="btn" to={workId ? `/works/${workId}` : '/works'}>
          {t('retake.back_to_work')}
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <div className="alert alert-error">{loadError}</div>
        <Link className="btn" to={workId ? `/works/${workId}` : '/works'}>
          {t('retake.back_to_work')}
        </Link>
      </div>
    );
  }

  if (!work) return <div className="empty-state">{t('retake.loading')}</div>;

  // 伴奏被删：重录要跟着重新混音，没有伴奏就无从混音
  if (!work.trackId || !track) {
    return (
      <div>
        <div className="alert alert-warn">{t('retake.track_deleted')}</div>
        <Link className="btn" to={`/works/${work.id}`}>
          {t('retake.back_to_work')}
        </Link>
      </div>
    );
  }

  if (track.status !== 'ready') {
    return (
      <div>
        <div className="alert alert-warn">
          {track.status === 'processing'
            ? t('retake.track_processing')
            : t('retake.track_failed', { reason: track.error ?? t('components.unknown_reason') })}
        </div>
        <Link className="btn" to={`/works/${work.id}`}>
          {t('retake.back_to_work')}
        </Link>
      </div>
    );
  }

  const fullscreen = phase !== 'pick';
  /**
   * 伴奏地址的版本号：升降调会在同一个 URL 背后换文件（移调伴奏生成好之后），
   * 浏览器不会自己重新加载 —— 移调状态每变一次就涨一位（见上面的 effect）。
   */
  const mediaUrl = trackMediaUrl(track.id, mediaVersion);

  const startHint =
    track.pitchStatus === 'processing'
      ? t('retake.hint.pitch_processing')
      : track.pitchStatus === 'failed'
        ? // 不挡重录（这版混的已经是原调），但要说清楚：重录片段会和旧片段同在原调上
          t('retake.hint.pitch_failed', {
            reason: track.pitchError ?? t('components.unknown_reason'),
          })
        : engine
          ? mic.permission !== 'granted'
            ? t('retake.hint.mic_permission')
            : mic.devices.length === 0
              ? t('retake.hint.no_mic')
              : micReady
                ? seekPlan
                  ? t('retake.hint.ready', {
                      start: formatDuration(seekPlan.seekPos),
                      lead_in: fmt.integer(RETAKE_LIMITS.leadInSec),
                    })
                  : t('retake.hint.preparing_audio')
                : t('retake.hint.connecting_mic')
          : t('retake.hint.preparing_audio');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('retake.title')}</h1>
          <p className="page-sub">
            {track.artist
              ? t('retake.subtitle_with_artist', {
                  title: work.title,
                  duration: formatDuration(work.vocalDuration),
                  artist: track.artist,
                })
              : t('retake.subtitle', {
                  title: work.title,
                  duration: formatDuration(work.vocalDuration),
                })}
          </p>
        </div>
        <Link className="btn btn-ghost" to={`/works/${work.id}`}>
          {t('retake.back_to_work')}
        </Link>
      </div>

      {actionError && <div className="alert alert-error" role="alert">{actionError}</div>}
      {captureWarning && <div className="alert alert-warn" role="alert">⚠️ {captureWarning}</div>}
      {work.status === 'mixing' && (
        <div className="alert alert-warn">{t('retake.mixing_warning')}</div>
      )}
      {beyondTrack && (
        <div className="alert alert-warn">
          {t('retake.beyond_track', {
            end: fmt.seconds(seekPlan!.songEnd),
            duration: formatDuration(track.duration),
          })}
        </div>
      )}

      {mic.error && (
        <div className="alert alert-error" role="alert">
          {mic.error}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => void mic.request()}
          >
            {t('retake.retry_permission')}
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
                controls={!fullscreen}
                playsInline
                preload="auto"
              />
            ) : (
              <audio
                ref={mediaCallbackRef}
                src={mediaUrl}
                controls={!fullscreen}
                preload="auto"
                style={{ position: 'absolute', left: 16, right: 16, bottom: 12 }}
              />
            )}

            {track.hasLyrics ? (
              <LyricsView
                lyrics={track.lyrics}
                lyricsOffsetMs={track.lyricsOffsetMs}
                mediaEl={mediaEl}
                canSeek={!fullscreen}
                overlay={track.kind === 'video' && !fullscreen}
                fullscreen={fullscreen}
              />
            ) : track.kind !== 'video' ? (
              <div className="stage-audio-visual">
                <div className="stage-disc-wrap">
                  <div className="stage-disc" />
                  <span className="stage-disc-note" aria-hidden="true">
                    🎵
                  </span>
                </div>
                <div className="stage-audio-title">{track.title}</div>
                <div className="small faint">{t('retake.audio_only')}</div>
              </div>
            ) : null}

            {fullscreen && (
              <>
                {track.kind === 'video' && <div className="stage-fs-scrim" />}
                <div className="stage-fs-ui">
                  <div className="stage-fs-info">
                    <div className="stage-fs-title">{track.title}</div>
                    <div className="stage-fs-status">
                      {phase === 'splicing' ? (
                        <>
                          <span className="spin" />
                          {t('retake.splicing')}
                        </>
                      ) : (
                        <>
                          <span className="rec-dot" />
                          <span>{t('retake.recording')}</span>
                          <span className="mono">{formatTimer(elapsedMs)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="stage-fs-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-lg"
                      disabled={phase !== 'recording'}
                      onClick={() => void handleStop()}
                    >
                      {phase === 'splicing' ? (
                        <>
                          <span className="spin" />
                          {t('retake.splicing')}
                        </>
                      ) : (
                        t('retake.finish')
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn-lg stage-fs-cancel"
                      disabled={phase !== 'recording'}
                      onClick={handleAbandon}
                    >
                      {t('retake.cancel')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {!fullscreen && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="record-bar">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={!canRecord}
                  onClick={() => void handleStart()}
                >
                  {t('retake.start')}
                </button>
                <span className="muted small">{startHint}</span>
              </div>
            </div>
          )}

          {/*
            重录说明挂在左列底部（原来是右列最后一张卡）：右列「重录哪一段」带着
            歌词行列表，比左列高出将近一倍，说明卡搬过来正好填掉左列下方的空白，
            两列高度也就齐了 —— 它本来就跟「开始重录」是一件事的注脚。
          */}
          <div className="card small muted" style={{ marginTop: 16 }}>
            <div className="panel-card-title">{t('retake.notes.title')}</div>
            <ul className="record-notes">
              <li>
                {t('retake.notes.replace_only', {
                  start: formatTimer(startSec * 1000),
                  end: formatTimer(endSec * 1000),
                })}
              </li>
              <li>
                {t('retake.notes.lead_in', { lead_in: fmt.integer(RETAKE_LIMITS.leadInSec) })}
              </li>
              <li>{t('retake.notes.crossfade')}</li>
              <li>{t('retake.notes.backup')}</li>
              <li>{t('retake.notes.remix')}</li>
            </ul>
          </div>
        </div>

        <div className="control-panel">
          <div className="card">
            <div className="panel-card-title">{t('retake.range.title')}</div>

            <div className="field">
              <div className="field-label">
                <span>{t('retake.range.start')}</span>
                <span className="field-value">{formatTimer(startSec * 1000)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.5}
                value={startSec}
                onChange={(event) => setRangeStart(Number(event.target.value))}
              />
            </div>

            <div className="field">
              <div className="field-label">
                <span>{t('retake.range.end')}</span>
                <span className="field-value">{formatTimer(endSec * 1000)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.5}
                value={endSec}
                onChange={(event) => setRangeEnd(Number(event.target.value))}
              />
            </div>

            <div className="retake-range-row">
              <label className="small faint">
                {t('retake.range.from')}
                <input
                  className="text-input"
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={Number(startSec.toFixed(1))}
                  onChange={(event) => setRangeStart(Number(event.target.value))}
                />
              </label>
              <label className="small faint">
                {t('retake.range.to')}
                <input
                  className="text-input"
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={Number(endSec.toFixed(1))}
                  onChange={(event) => setRangeEnd(Number(event.target.value))}
                />
              </label>
              <span className="small faint">
                {t('retake.range.segment_duration', {
                  duration: formatDuration(endSec - startSec),
                })}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={togglePreview}>
                {previewing ? t('retake.preview.stop') : t('retake.preview.start')}
              </button>
            </div>
            <div className="small faint" style={{ marginTop: 6 }}>
              {work.status === 'ready'
                ? t('retake.preview.note_mix')
                : t('retake.preview.note_vocal')}
            </div>

            {lyricRanges.length > 0 && (
              <div className="field" style={{ marginTop: 16 }}>
                <div className="field-label">
                  <span>{t('retake.lyrics.title')}</span>
                </div>
                {/* 说明单独一行：塞在标题右边会在窄列里折成两半，读着像排版错误 */}
                <div className="small faint">{t('retake.lyrics.hint')}</div>
                <div className="retake-lyrics">
                  {lyricRanges.map((line, index) => {
                    const inRange =
                      line.startSec >= startSec - 0.001 && line.startSec <= endSec + 0.001;
                    return (
                      <div
                        key={`${index}-${line.timeMs}`}
                        className={`retake-lyric-row${inRange ? ' in-range' : ''}`}
                      >
                        <span className="mono small faint retake-lyric-time">
                          {formatLrcTimestamp(line.timeMs)}
                        </span>
                        <span className="retake-lyric-text">{line.text || '…'}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setRangeStart(line.startSec)}
                        >
                          {t('retake.lyrics.from')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setRangeEnd(line.endSec)}
                        >
                          {t('retake.lyrics.to')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="panel-card-title">{t('retake.mic.title')}</div>
            <div className="field">
              <div className="field-label">
                <span>{t('retake.mic.device')}</span>
                {mic.permission !== 'granted' && (
                  <span className="faint small">{t('retake.mic.not_granted')}</span>
                )}
              </div>
              <select
                className="select-input"
                value={mic.deviceId}
                disabled={mic.permission !== 'granted' || phase !== 'pick' || mic.devices.length === 0}
                onChange={(event) => mic.selectDevice(event.target.value)}
              >
                {mic.devices.length === 0 && (
                  <option value="">
                    {mic.permission === 'granted'
                      ? t('retake.mic.no_external')
                      : t('retake.mic.awaiting_permission')}
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
                  <div className="small faint">
                    {t('retake.mic.all_shown')}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('retake.mic.external_only')}
                    </button>
                  </div>
                ) : mic.devices.length === 0 ? (
                  <div className="alert alert-warn" style={{ marginTop: 8 }}>
                    {t('retake.mic.no_external_found', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('retake.mic.show_all')}
                    </button>
                  </div>
                ) : (
                  <div className="small faint">
                    {t('retake.mic.external_only_note', {
                      devices: fmt.list(mic.hiddenBuiltinLabels),
                    })}
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      {t('retake.mic.show_all')}
                    </button>
                  </div>
                ))}
              <div className="field-label" style={{ marginTop: 6 }}>
                <span>{t('retake.mic.level')}</span>
                <span className="faint small">
                  {micReady ? t('retake.mic.try_speaking') : t('retake.mic.not_connected')}
                </span>
              </div>
              <LevelMeter engine={engine} active={micReady} />
            </div>
          </div>
        </div>
      </div>

      {/* 试听用的小播放器：单独一个元素，不碰舞台上那个伴奏元素 */}
      <audio ref={previewElRef} src={previewUrl} preload="auto" style={{ display: 'none' }} />
    </div>
  );
}

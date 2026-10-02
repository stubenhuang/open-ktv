import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LRC_LIMITS, MAX_RECORD_MS, MIN_RECORD_MS } from '../../../shared/types';
import { api, trackMediaUrl, type TrackDetail } from '../api';
import { LevelMeter } from '../components/LevelMeter';
import { LyricsView } from '../components/LyricsView';
import { KtvEngine, isMicSupported } from '../audio/engine';
import { useMicDevices } from '../hooks/useMicDevices';
import { errorMessage, formatDuration, formatTimer } from '../utils';

type Phase = 'idle' | 'saving';

export default function SingPage() {
  const { trackId = '' } = useParams();
  const navigate = useNavigate();

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
          setActionError(`歌词微调保存失败：${errorMessage(err)}`);
        });
      }, 400);
    },
    [track],
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
        setActionError(`接入麦克风失败：${errorMessage(err)}`);
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

    try {
      const result = await engine.stopRecording();
      setRecording(false);

      // 采集期间有整拍拿不到输入 → 设备在抖。这种丢音没法事后补，
      // 但必须让用户知道「不是自己唱的问题」。
      if (result.droppedRatio > 0.005) {
        setCaptureWarning(
          `这次录音有 ${(result.droppedRatio * 100).toFixed(1)}% 的时间片没采到，` +
            '声音可能会断断续续。多半是音频设备/驱动或系统负载的问题，' +
            '可以关掉别的占资源的程序、换一个麦克风接口再试。',
        );
      } else if (
        result.captureSettings.echoCancellation ||
        result.captureSettings.noiseSuppression
      ) {
        setCaptureWarning(
          '这个麦克风的驱动强制开启了「回声消除/降噪」，浏览器关不掉。' +
            '它们会把歌声当成噪声处理，录出来可能发闷或断断续续。' +
            '如果设备支持，去系统声音设置里把「环境降噪」之类的选项关掉。',
        );
      }

      // 音频设备中途挂掉时，采集到的数据会远少于实际录制时长。
      // 这种情况必须单独报出来 —— 否则用户只会看到「录音太短」，完全摸不着头脑。
      const expectedSec = elapsedRef.current / 1000;
      if (expectedSec > 1.5 && result.durationSec < expectedSec * 0.6) {
        const contextState = engine.context.state;
        setActionError(
          `只采集到 ${result.durationSec.toFixed(1)} 秒音频，但录音持续了约 ${expectedSec.toFixed(1)} 秒` +
            `（音频上下文状态：${contextState}）。多半是音频设备/驱动中途出错了，` +
            '请检查耳机和麦克风后重试。',
        );
        return;
      }

      if (result.durationSec * 1000 < MIN_RECORD_MS) {
        setActionError('录音太短了，至少唱满 1 秒再结束。');
        return;
      }

      setPhase('saving');
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
      setActionError(
        `结束录音失败：${errorMessage(err)}`,
      );
    }
  }, [engine, track, navigate]);

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
      setActionError(errorMessage(err, '开始演唱失败'));
    }
  }, [engine, track]);

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
          这个浏览器缺少录音所需的 Web Audio 能力（AudioWorklet / getUserMedia）。
          请用桌面版 Chrome 或 Edge 打开。
        </div>
        <Link className="btn" to="/">
          返回伴奏库
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <div className="alert alert-error">{loadError}</div>
        <Link className="btn" to="/">
          返回伴奏库
        </Link>
      </div>
    );
  }

  if (!track) return <div className="empty-state">正在加载伴奏…</div>;

  if (track.status !== 'ready') {
    return (
      <div>
        <div className="alert alert-warn">
          {track.status === 'processing'
            ? `这个伴奏还在转码中（${Math.round((track.progress ?? 0) * 100)}%），转好之后才能演唱。`
            : `这个伴奏处理失败了：${track.error ?? '未知原因'}`}
        </div>
        <Link className="btn" to="/">
          返回伴奏库
        </Link>
      </div>
    );
  }

  const canStart = Boolean(engine) && micReady && !recording && phase === 'idle';
  const mediaUrl = trackMediaUrl(track.id);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{track.title}</h1>
          <p className="page-sub">
            {track.artist ? `${track.artist} · ` : ''}
            {formatDuration(track.duration)} · {track.kind === 'video' ? '视频伴奏' : '音频伴奏'}
          </p>
        </div>
        <Link className="btn btn-ghost" to="/">
          返回伴奏库
        </Link>
      </div>

      <div className="alert alert-warn">
        🎧 请戴上耳机再唱。为了保证音质，我们特意关掉了浏览器的「降噪 / 回声消除」——
        那套处理是给语音通话做的，会把歌声当成噪声削掉（实测能削掉 18dB，听感就是断断续续）。
        代价是不再自动防啸叫：外放时麦克风会把伴奏收回去，轻则串音重则啸叫。
        另外蓝牙耳机延迟通常 150ms 以上，耳返会明显拖拍，建议用有线耳机。
      </div>

      {actionError && <div className="alert alert-error">{actionError}</div>}

      {captureWarning && <div className="alert alert-warn">⚠️ {captureWarning}</div>}

      {mic.error && (
        <div className="alert alert-error">
          {mic.error}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => void mic.request()}
          >
            重试授权
          </button>
        </div>
      )}

      <div className="sing-grid">
        <div>
          <div className="stage">
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
                overlay={track.kind === 'video'}
              />
            ) : track.kind !== 'video' ? (
              <div className="stage-audio-visual">
                <div className="big">🎵</div>
                <div>{track.title}</div>
                <div className="small faint">音频伴奏（无画面）</div>
              </div>
            ) : null}

            {recording && (
              <div className="record-overlay">
                <span className="rec-dot" />
                录音中
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="record-bar">
              {recording ? (
                <>
                  <span className="timer mono">{formatTimer(elapsedMs)}</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    disabled={phase !== 'idle'}
                    onClick={() => void handleStop()}
                  >
                    {phase === 'saving' ? (
                      <>
                        <span className="spin" />
                        正在合成…
                      </>
                    ) : (
                      '结束演唱'
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={phase !== 'idle'}
                    onClick={handleAbandon}
                  >
                    放弃重唱
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    disabled={!canStart}
                    onClick={() => void handleStart()}
                  >
                    开始演唱
                  </button>
                  <span className="muted small">
                    {engine
                      ? mic.permission !== 'granted'
                        ? '等待麦克风授权…'
                        : mic.devices.length === 0
                          ? '没有可用的外置麦克风，插上麦克风后这里会自动出现。'
                          : micReady
                            ? '点开始后会先起录 0.15 秒静音再放伴奏，系统精确测量伴奏起播时刻，用来自动对齐。'
                            : '正在接入麦克风…'
                      : '正在初始化音频…'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="control-panel">
          <div className="card">
            <div className="field">
              <div className="field-label">
                <span>麦克风</span>
                {mic.permission !== 'granted' && <span className="faint small">未授权</span>}
              </div>
              <select
                className="select-input"
                value={mic.deviceId}
                disabled={mic.permission !== 'granted' || recording || mic.devices.length === 0}
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

              {/* 只列外置输入：内置麦克风被藏起来了，这里说清它们去哪了，并留一个「全都放出来」的开关
                  （判据是设备名，所以把藏掉的名字也列出来 —— 万一认错了用户一眼能看出来并自己救回来） */}
              {mic.hiddenBuiltinLabels.length > 0 &&
                (mic.showBuiltin ? (
                  <div className="small faint">
                    已显示全部输入设备（含内置麦克风）。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      只看外置
                    </button>
                  </div>
                ) : mic.devices.length === 0 ? (
                  <div className="alert alert-warn" style={{ marginTop: 8 }}>
                    没检测到外置麦克风，已隐藏：{mic.hiddenBuiltinLabels.join('、')}。
                    插上 USB / 3.5mm 麦克风后会自动出现在这里。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      显示全部设备
                    </button>
                  </div>
                ) : (
                  <div className="small faint">
                    只列外置输入（已隐藏：{mic.hiddenBuiltinLabels.join('、')}）。
                    <button type="button" className="link-btn" onClick={mic.toggleBuiltin}>
                      显示全部设备
                    </button>
                  </div>
                ))}
              <div className="field-label" style={{ marginTop: 6 }}>
                <span>输入电平</span>
                <span className="faint small">{micReady ? '对着麦克风说话试试' : '未接入'}</span>
              </div>
              <LevelMeter engine={engine} active={micReady} />
            </div>
          </div>

          <div className="card">
            <div className="field">
              <div className="field-label">
                <span>伴奏音量（耳机里听到的）</span>
                <span className="field-value">{Math.round(accompVolume * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={accompVolume}
                onChange={(event) => setAccompVolume(Number(event.target.value))}
              />
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <div className="field-label">
                <span>自己声音（耳返）</span>
                <span className="field-value">
                  {micMonitoring ? `${Math.round(micVolume * 100)}%` : '已关闭'}
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
                开启人声耳返（关掉只听得见伴奏）
              </label>
            </div>
          </div>

          {track.hasLyrics && (
            <div className="card">
              <div className="field">
                <div className="field-label">
                  <span>歌词对轴微调</span>
                  <span className="field-value">
                    {lyricsOffsetMs > 0 ? '+' : ''}
                    {lyricsOffsetMs} ms
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
                    正值 = 歌词更晚出现。歌词跑在前面就往正拖，改完自动保存。
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={lyricsOffsetMs === 0}
                    onClick={() => applyLyricsOffset(0)}
                  >
                    归零
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="card small muted">
            <strong style={{ color: 'var(--text)' }}>录音说明</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>只录你的干声，伴奏不进录音文件。</li>
              <li>结束后服务端把干声和伴奏合成 192kbps 立体声 MP3。</li>
              <li>录完去作品库点「调混音」：实时试听即时生效，点「合成」出新版 MP3。</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

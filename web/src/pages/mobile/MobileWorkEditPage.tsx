import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MixParams } from '../../../../shared/types';
import { api, trackMediaUrl, workVocalUrl, type WorkListItem } from '../../api';
import { PreviewEngine } from '../../audio/preview';
import { MobileMixPanel } from '../../components/MobileMixPanel';
import { toast } from '../../components/ToastStack';
import { usePolling } from '../../hooks/usePolling';
import { errorMessage, formatDuration } from '../../utils';

/**
 * 手机端作品编辑页：实时试听 + 效果调整 + 合成。
 *
 * 与桌面 WorkDetailPage 是同一套引擎（PreviewEngine 在浏览器里复刻服务端滤波器链，
 * 参数改动只操作本地音频图节点），同一套参数口径（shared/types 的 MIX_LIMITS）。
 * 差别：合成后不跳走，留在详情页等结果 —— 手机上「返回作品库」是个明确的离开动作，
 * 而这里用户往往想马上再听一遍。
 */
export default function MobileWorkEditPage() {
  const { workId = '' } = useParams();
  const navigate = useNavigate();

  const [work, setWork] = useState<WorkListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ------------------------------ 实时试听引擎 ------------------------------ */

  const [previewEngine, setPreviewEngine] = useState<PreviewEngine | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const previewRef = useRef<PreviewEngine | null>(null);
  const latestParamsRef = useRef<MixParams | null>(null);
  const latestParamsWorkIdRef = useRef('');

  // 每首作品只初始化一次；之后由 MobileMixPanel 的 onParamsChange 接管
  useEffect(() => {
    if (!work || latestParamsWorkIdRef.current === work.id) return;
    latestParamsWorkIdRef.current = work.id;
    latestParamsRef.current = work.mixParams;
  }, [work]);

  // 换作品 / 卸载：销毁引擎，避免上一首的音频图继续占着共享 AudioContext
  useEffect(() => {
    return () => {
      previewRef.current?.dispose();
      previewRef.current = null;
      setPreviewEngine(null);
      setPlaying(false);
    };
  }, [workId]);

  const load = useCallback(async () => {
    try {
      setWork(await api.getWork(workId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, '加载作品失败'));
    }
  }, [workId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 合成中轮询；好了就停
  usePolling(() => void load(), 1500, work?.status === 'mixing');

  /** 懒加载：第一次点「试听」才解码（顺带满足自动播放策略的用户手势要求） */
  const handlePreviewPlay = async () => {
    if (!work || !work.trackId || previewRef.current || previewLoading) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const engine = await PreviewEngine.create({
        vocalUrl: workVocalUrl(work.id),
        accompUrl: trackMediaUrl(work.trackId),
      });
      previewRef.current = engine;
      setPreviewEngine(engine);
      engine.onEnded = () => setPlaying(false);
      if (latestParamsRef.current) {
        engine.setParams(latestParamsRef.current, work.autoOffsetMs, work.levels);
      }
      await engine.play();
      setPlaying(true);
      setDuration(engine.durationSec);
    } catch (err) {
      previewRef.current?.dispose();
      previewRef.current = null;
      setPreviewEngine(null);
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const togglePlay = () => {
    const engine = previewRef.current;
    if (!engine) {
      void handlePreviewPlay();
      return;
    }
    void engine.toggle().then(
      () => {
        setPlaying(engine.playing);
        setDuration(engine.durationSec);
      },
      (err: unknown) => {
        setPlaying(false);
        setPreviewError(errorMessage(err));
      },
    );
  };

  // 播放中定时读位置（和桌面 LivePreview 同一个思路：200ms 足够顺眼）
  useEffect(() => {
    const engine = previewRef.current;
    if (!engine || !playing) return;
    const timer = window.setInterval(() => {
      setPosition(engine.positionSec);
      setDuration(engine.durationSec);
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing, previewEngine]);

  const seek = (value: number) => {
    setPosition(value);
    previewRef.current?.seek(value);
  };

  /** MobileMixPanel 每次改动 → 立即送进预览引擎（纯本地，零请求） */
  const handleParamsChange = (params: MixParams) => {
    latestParamsRef.current = params;
    if (!previewRef.current || !work) return;
    previewRef.current.setParams(params, work.autoOffsetMs, work.levels);
  };

  const handleApply = async (params: MixParams) => {
    if (!work) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.remixWork(work.id, params);
      toast.ok('已提交合成，几秒后刷新就是新版');
      await load();
    } catch (err) {
      setActionError(errorMessage(err, '合成失败'));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <button type="button" className="m-back" onClick={() => navigate(-1)}>
            ‹ 返回
          </button>
        </div>
        <div className="m-alert m-alert-error">{loadError}</div>
      </div>
    );
  }

  if (!work) return <div className="m-page"><div className="m-empty">正在加载作品…</div></div>;

  if (!work.trackId) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <button type="button" className="m-back" onClick={() => navigate(-1)}>
            ‹ 返回
          </button>
          <div className="m-topbar-title">
            <div className="m-topbar-name">{work.title}</div>
          </div>
        </div>
        <div className="m-alert m-alert-warn">
          这个作品用的伴奏已经被删除了。已生成的 MP3 还能播放 / 下载，
          但实时试听和重新合成都需要伴奏文件，所以不能调整效果。
        </div>
      </div>
    );
  }

  return (
    <div className="m-page m-edit">
      <div className="m-topbar">
        <Link className="m-back" to={`/m/work/${work.id}`}>
          ‹ 返回
        </Link>
        <div className="m-topbar-title">
          <div className="m-topbar-name">调整效果</div>
          <div className="m-topbar-sub">
            {work.trackTitle ?? ''} · {formatDuration(work.vocalDuration)}
            {work.status === 'mixing' ? ' · 合成中…' : ''}
          </div>
        </div>
      </div>

      {actionError && <div className="m-alert m-alert-error">{actionError}</div>}
      {previewError && <div className="m-alert m-alert-warn">试听失败：{previewError}</div>}

      {/* 试听传输条：干声 + 伴奏在浏览器里实时混音 */}
      <div className="m-preview">
        <button
          type="button"
          className="m-play-btn"
          aria-label={playing ? '暂停' : '试听'}
          disabled={previewLoading}
          onClick={togglePlay}
        >
          <span aria-hidden="true">{previewLoading ? '…' : playing ? '⏸' : '▶'}</span>
        </button>
        <input
          className="m-seek"
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(position, Math.max(duration, 0.1))}
          disabled={!previewEngine}
          aria-label="试听进度"
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="m-time mono">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>
      </div>
      <p className="m-notes">
        干声和伴奏在手机里实时混音：拖滑块、改毫秒都会立刻生效，不打断播放。这只是预览 ——
        点「合成」服务端才真正出新版 MP3。
      </p>

      <MobileMixPanel value={work.mixParams} onParamsChange={handleParamsChange} />

      {/* 粘底合成栏：面板很长，滚到底也不用滑回去。
          用 latestParamsRef 而不是 work.mixParams —— 后者是服务端的旧值，
          用户拖过的滑块都在 ref 里（MobileMixPanel 的每次改动都会写它）。 */}
      <div className="m-sticky-bar">
        <button
          type="button"
          className="m-btn m-btn-primary m-btn-record"
          disabled={busy}
          onClick={() => void handleApply(latestParamsRef.current ?? work.mixParams)}
        >
          {busy ? '合成中…' : '合成'}
        </button>
      </div>
    </div>
  );
}

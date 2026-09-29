import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MixParams } from '../../../shared/types';
import { api, trackMediaUrl, workVocalUrl, type WorkListItem } from '../api';
import { PreviewEngine } from '../audio/preview';
import { LivePreview, type PreviewStatus } from '../components/LivePreview';
import { MixPanel } from '../components/MixPanel';
import { usePolling } from '../hooks/usePolling';
import { errorMessage, formatDateTime, formatDuration } from '../utils';

/**
 * 作品编辑页：单列列表式排版 —— 实时试听 → 混音调整。
 *
 * 成品 MP3 的播放/下载都在作品库列表页；这里只负责「试听 + 调参 + 合成」，
 * 点「合成」发一次混音请求后直接返回作品库（定位到这首作品），
 * 在列表里等「正在合成… → 已就绪」即可。
 */
export default function WorkDetailPage() {
  const { workId = '' } = useParams();
  const navigate = useNavigate();

  const [work, setWork] = useState<WorkListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  /** 合成请求 in-flight（按钮 loading 用）；控件不被它禁用，试听随时可调 */
  const [busy, setBusy] = useState(false);
  /**
   * ffmpeg 是否支持 rubberband（升降调）。缺失时把控件禁掉并说明原因，
   * 而不是让用户拖一个服务端会忽略的滑块。默认 true：探测结果没回来之前
   * 不该假装功能不可用。
   */
  const [rubberbandAvailable, setRubberbandAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((health) => {
        if (!cancelled) setRubberbandAvailable(health.capabilities.rubberband);
      })
      .catch(() => {
        // 拿不到就当支持：服务端会自己降级，不必因此吓唬用户
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------ 实时试听引擎 ------------------------------ */

  const [previewEngine, setPreviewEngine] = useState<PreviewEngine | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRef = useRef<PreviewEngine | null>(null);
  /** MixPanel 里的最新参数（含未提交的改动）；引擎建好后按它初始化 */
  const latestParamsRef = useRef<MixParams | null>(null);
  /** latestParamsRef 是否为当前作品初始化过：轮询刷新不覆盖用户正在拖的改动 */
  const latestParamsWorkIdRef = useRef('');

  // 每首作品只初始化一次；之后由 MixPanel 的 onParamsChange 接管。
  // （若跟着轮询刷新走，用户拖到一半的滑块会被 1.5s 一次的 load 弹回旧值）
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
      setPreviewStatus('idle');
      setPreviewError(null);
    };
  }, [workId]);

  /** 懒加载：第一次点「试听」才解码（顺带满足自动播放策略的用户手势要求）。返回起播的引擎，失败返回 null */
  const handlePreviewPlay = async (): Promise<PreviewEngine | null> => {
    if (!work || previewRef.current || previewStatus === 'loading') return null;
    setPreviewStatus('loading');
    setPreviewError(null);
    try {
      const engine = await PreviewEngine.create({
        vocalUrl: workVocalUrl(work.id),
        accompUrl: trackMediaUrl(work.trackId),
      });
      previewRef.current = engine;
      setPreviewEngine(engine);
      setPreviewStatus('ready');
      if (latestParamsRef.current) {
        engine.setParams(latestParamsRef.current, work.autoOffsetMs, work.levels);
      }
      await engine.play();
      return engine;
    } catch (err) {
      // 解码失败（伴奏被删等）或浏览器拦截播放：保留可重试状态
      previewRef.current?.dispose();
      previewRef.current = null;
      setPreviewEngine(null);
      setPreviewStatus('error');
      setPreviewError(errorMessage(err));
      return null;
    }
  };

  /** MixPanel 每次改动 → 立即送进预览引擎（纯本地，零请求） */
  const handleParamsChange = (params: MixParams) => {
    latestParamsRef.current = params;
    if (!previewRef.current || !work) return;
    previewRef.current.setParams(params, work.autoOffsetMs, work.levels);
  };

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

  // 只在等待初始混音（唱完刚落页）时轮询；点「合成」后已经回列表页，不等结果
  usePolling(() => void load(), 1500, work?.status === 'mixing');

  /** 点「合成」：发一次混音请求，成功即返回作品库并定位到这首作品 */
  const handleApply = async (params: MixParams) => {
    if (!work) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.remixWork(work.id, params);
      navigate('/works', { state: { focusWorkId: work.id } });
    } catch (err) {
      // 失败留在本页，让用户改完参数再点一次
      setActionError(errorMessage(err, '合成失败'));
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async () => {
    if (!work) return;
    setBusy(true);
    try {
      await api.updateWork(work.id, { title: titleDraft });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err, '重命名失败'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!work) return;
    if (!window.confirm(`确定删除作品「${work.title}」吗？`)) return;
    try {
      await api.deleteWork(work.id);
      navigate('/works');
    } catch (err) {
      setActionError(errorMessage(err, '删除失败'));
    }
  };

  if (loadError) {
    return (
      <div>
        <div className="alert alert-error">{loadError}</div>
        <Link className="btn" to="/works">
          返回作品库
        </Link>
      </div>
    );
  }

  if (!work) return <div className="empty-state">正在加载作品…</div>;

  const mixing = work.status === 'mixing';

  return (
    <div>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <div className="row" style={{ gap: 8 }}>
              <input
                className="text-input"
                value={titleDraft}
                autoFocus
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleRename();
                  if (event.key === 'Escape') setEditing(false);
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => void handleRename()}
              >
                保存
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          ) : (
            <h1 className="page-title">
              {work.title}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 8, verticalAlign: 'middle' }}
                onClick={() => {
                  setTitleDraft(work.title);
                  setEditing(true);
                }}
              >
                改名
              </button>
              {/* 成品 MP3 的徽章跟着状态走：唱完刚落页时能看到初始混音的进度 */}
              {mixing ? (
                <span className="badge badge-work" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                  <span className="spin" style={{ borderTopColor: 'var(--accent-2)' }} />
                  正在合成…
                </span>
              ) : work.status === 'ready' ? (
                <span className="badge badge-ok" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                  已就绪
                </span>
              ) : null}
            </h1>
          )}
          <p className="page-sub">
            {work.trackTitle ? `伴奏：${work.trackTitle} · ` : ''}
            演唱时长 {formatDuration(work.vocalDuration)} · {formatDateTime(work.createdAt)}
          </p>
        </div>
        <div className="row">
          <Link className="btn btn-ghost" to="/works">
            返回作品库
          </Link>
          <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}>
            删除
          </button>
        </div>
      </div>

      {actionError && <div className="alert alert-error">{actionError}</div>}

      {work.status === 'failed' && (
        <div className="alert alert-error">
          合成失败：{work.error ?? '未知原因'}
          <br />
          常见原因：伴奏文件被删了、磁盘写满、或者干声文件损坏。可以调一下参数再点「合成」试试。
        </div>
      )}

      <div className="detail-stack">
        <LivePreview
          engine={previewEngine}
          status={previewStatus}
          error={previewError}
          onRequestPlay={handlePreviewPlay}
        />
        <MixPanel
          value={work.mixParams}
          busy={busy}
          onApply={(params) => void handleApply(params)}
          onParamsChange={handleParamsChange}
          rubberbandAvailable={rubberbandAvailable}
        />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MixParams } from '../../../shared/types';
import { api, trackMediaUrl, workAudioUrl, workVocalUrl, type WorkListItem } from '../api';
import { PreviewEngine } from '../audio/preview';
import { LivePreview, type PreviewStatus } from '../components/LivePreview';
import { MixPanel } from '../components/MixPanel';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, formatDuration } from '../utils';

export default function WorkDetailPage() {
  const { workId = '' } = useParams();
  const navigate = useNavigate();

  const [work, setWork] = useState<WorkListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showVocal, setShowVocal] = useState(false);

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
      setPreviewError(err instanceof Error ? err.message : String(err));
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
      setLoadError(err instanceof Error ? err.message : '加载作品失败');
    }
  }, [workId]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(() => void load(), 1500, work?.status === 'mixing');

  const handleApply = async (params: MixParams) => {
    if (!work) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.remixWork(work.id, params);
      setWork((previous) => (previous ? { ...previous, ...updated } : previous));
      // 让轮询接手，等 status 变回 ready
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '重新生成失败');
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
      setActionError(err instanceof Error ? err.message : '重命名失败');
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
      setActionError(err instanceof Error ? err.message : '删除失败');
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
          常见原因：伴奏文件被删了、磁盘写满、或者干声文件损坏。可以调一下参数再点「重新生成」试试。
        </div>
      )}

      <div className="detail-grid">
        <div className="card">
          <div className="row-between" style={{ marginBottom: 14 }}>
            <strong>成品 MP3</strong>
            {mixing ? (
              <span className="badge badge-work">
                <span className="spin" style={{ borderTopColor: 'var(--accent-2)' }} />
                正在合成…
              </span>
            ) : (
              work.status === 'ready' && <span className="badge badge-ok">已就绪</span>
            )}
          </div>

          {work.status === 'ready' ? (
            <audio
              controls
              preload="auto"
              style={{ width: '100%' }}
              src={workAudioUrl(work.id, work.updatedAt)}
            />
          ) : (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              {mixing ? '正在把干声和伴奏合成 MP3，通常几秒钟…' : '还没有可播放的成品'}
            </div>
          )}

          <div className="row" style={{ gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <a
              className="btn btn-primary"
              href={`${workAudioUrl(work.id)}?download=1`}
              style={work.status !== 'ready' ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
            >
              下载 MP3
            </a>
            <button
              type="button"
              className="btn"
              onClick={() => setShowVocal((value) => !value)}
              disabled={work.status !== 'ready'}
            >
              {showVocal ? '收起干声' : '试听干声（调对齐用）'}
            </button>
          </div>

          {showVocal && (
            <div style={{ marginTop: 14 }}>
              <div className="small faint" style={{ marginBottom: 6 }}>
                这是麦克风录的原始干声，没有任何伴奏。跟上面的成品来回切着听，
                就能判断人声是早了还是拖了，然后调「人声对齐微调」（拖滑块或直接输入毫秒数）。
              </div>
              <audio controls preload="none" style={{ width: '100%' }} src={workVocalUrl(work.id)} />
            </div>
          )}

          <div className="small faint" style={{ marginTop: 16 }}>
            自动测得的人声起点偏移：<span className="mono">{work.autoOffsetMs} ms</span>
            （服务端按这个值把干声对齐到伴奏时间轴）
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <LivePreview
            engine={previewEngine}
            status={previewStatus}
            error={previewError}
            onRequestPlay={handlePreviewPlay}
          />
          <MixPanel
            value={work.mixParams}
            busy={busy || mixing}
            disabled={work.status === 'failed'}
            onApply={(params) => void handleApply(params)}
            onParamsChange={handleParamsChange}
          />
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, workAudioUrl, type WorkListItem } from '../api';
import { AudioPlayer } from '../components/AudioPlayer';
import { confirmAction } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { WorkSkeletonGrid } from '../components/Skeleton';
import { toast } from '../components/ToastStack';
import { usePolling } from '../hooks/usePolling';
import { coverGradient, errorMessage, formatDateTime, formatDuration } from '../utils';

export default function WorksPage() {
  const location = useLocation();
  const [works, setWorks] = useState<WorkListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 从详情页点「合成」跳回来时要定位的作品 id */
  const focusWorkId =
    (location.state as { focusWorkId?: string } | null | undefined)?.focusWorkId ?? null;
  const focusedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setWorks(await api.listWorks());
      setError(null);
    } catch (err) {
      setError(errorMessage(err, '加载作品失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 定位到目标作品：滚动到视口中央 + 高亮几秒（合成后跳回来用）
  useEffect(() => {
    if (!focusWorkId || focusedRef.current || loading || works.length === 0) return;
    const card = document.querySelector(`[data-work-id="${focusWorkId}"]`);
    if (!card) return;
    focusedRef.current = true;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('work-card-focus');
    const timer = window.setTimeout(() => card.classList.remove('work-card-focus'), 2600);
    return () => window.clearTimeout(timer);
  }, [focusWorkId, loading, works]);

  const hasMixing = works.some((work) => work.status === 'mixing');
  usePolling(() => void load(), 1500, hasMixing);

  const handleDelete = async (work: WorkListItem) => {
    const confirmed = await confirmAction({
      title: '删除作品',
      message: `确定删除作品「${work.title}」吗？录音干声和成品 MP3 都会一起删掉。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      toast.ok(`已删除作品「${work.title}」`);
      await load();
    } catch (err) {
      setError(errorMessage(err, '删除失败'));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">我的作品</h1>
          <p className="page-sub">每唱一次都会存下一版 MP3，随时回听、下载或调整效果。</p>
        </div>
        <Link className="btn" to="/">
          去伴奏库
        </Link>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <WorkSkeletonGrid />
      ) : works.length === 0 ? (
        <EmptyState
          icon="🎤"
          title="还没有作品"
          description="去伴奏库选一首，戴上耳机开始你的第一次演唱吧。"
          action={
            <Link className="btn btn-primary" to="/">
              去伴奏库
            </Link>
          }
        />
      ) : (
        <div className="work-list">
          {works.map((work) => (
            <div key={work.id} className="work-card" data-work-id={work.id}>
              {/*
                封条色相由标题哈希决定（coverGradient）：同一首歌每次同色、
                不同歌错开，一屏八张卡不再是一片同样的灰。
              */}
              <div className="work-cover" style={{ background: coverGradient(work.title) }}>
                <span className="work-cover-icon" aria-hidden="true">
                  🎵
                </span>
                <span className="work-cover-duration">{formatDuration(work.vocalDuration)}</span>
              </div>

              <div>
                <div className="work-card-title" title={work.title}>
                  {work.title}
                </div>
                <div className="track-meta">
                  {work.trackTitle ? (
                    <span>伴奏：{work.trackTitle}</span>
                  ) : (
                    <span className="badge badge-fail" title="伴奏已删除，成品还能听，但不能重新合成">
                      伴奏已删除
                    </span>
                  )}
                  <span>{formatDateTime(work.createdAt)}</span>
                </div>
              </div>

              {work.status === 'mixing' && (
                <div className="badge badge-work">
                  <span className="spin" style={{ borderTopColor: 'var(--accent-2)' }} />
                  正在合成…
                </div>
              )}

              {work.status === 'failed' && (
                <div className="badge badge-fail">合成失败：{work.error ?? '未知原因'}</div>
              )}

              {work.status === 'ready' && (
                <AudioPlayer src={workAudioUrl(work.id, work.updatedAt)} preload="none" />
              )}

              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Link className="btn btn-sm" to={`/works/${work.id}`} title="试听效果、调整参数并重新合成">
                  调整效果
                </Link>
                <a
                  className="btn btn-sm"
                  href={`${workAudioUrl(work.id)}?download=1`}
                  style={work.status !== 'ready' ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
                >
                  下载 MP3
                </a>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => void handleDelete(work)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

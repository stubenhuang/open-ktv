import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, workAudioUrl, type WorkListItem } from '../../api';
import { AudioPlayer } from '../../components/AudioPlayer';
import { confirmAction } from '../../components/ConfirmDialog';
import { toast } from '../../components/ToastStack';
import { usePolling } from '../../hooks/usePolling';
import { errorMessage, formatBytes, formatDateTime, formatDuration } from '../../utils';

/**
 * 手机端作品详情/结果页。
 *
 * 唱完落这里等合成 → 试听成品；往下是三个动作：调整效果（进编辑页）、
 * 改名、删除。成品 MP3 与桌面「我的作品」完全同一个文件，
 * 电脑端照样能播放 / 下载 / 再调。
 */
export default function MobileWorkPage() {
  const { workId = '' } = useParams();
  const navigate = useNavigate();
  const [work, setWork] = useState<WorkListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getWork(workId)
      .then((result) => {
        if (!cancelled) setWork(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, '加载作品失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [workId]);

  // 合成中才轮询：好了 / 挂了都不再打接口
  usePolling(
    () => {
      api
        .getWork(workId)
        .then(setWork)
        .catch((err: unknown) => setError(errorMessage(err, '刷新状态失败')));
    },
    1500,
    work?.status === 'mixing',
  );

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const next = await api.remixWork(workId, {});
      setWork({ ...(work as WorkListItem), ...next });
    } catch (err) {
      setError(errorMessage(err, '重试合成失败'));
    } finally {
      setRetrying(false);
    }
  };

  const rename = async () => {
    if (!work) return;
    setRenaming(true);
    try {
      await api.updateWork(work.id, { title: titleDraft });
      setEditing(false);
      toast.ok('已改名');
      setWork(await api.getWork(work.id));
    } catch (err) {
      setError(errorMessage(err, '重命名失败'));
    } finally {
      setRenaming(false);
    }
  };

  const remove = async () => {
    if (!work) return;
    const confirmed = await confirmAction({
      title: '删除作品',
      message: `确定删除作品「${work.title}」吗？录音干声和成品 MP3 都会一起删掉。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      toast.ok('已删除');
      navigate('/m/works');
    } catch (err) {
      setError(errorMessage(err, '删除失败'));
    }
  };

  if (error && !work) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            ‹ 返回
          </Link>
        </div>
        <div className="m-alert m-alert-error">{error}</div>
      </div>
    );
  }

  if (!work) {
    return (
      <div className="m-page">
        <div className="m-empty">正在加载…</div>
      </div>
    );
  }

  return (
    <div className="m-page">
      <div className="m-topbar">
        <Link className="m-back" to="/m/works">
          ‹ 返回
        </Link>
        <div className="m-topbar-title">
          {editing ? (
            <div className="m-rename-row">
              <input
                className="m-input"
                value={titleDraft}
                autoFocus
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void rename();
                  if (event.key === 'Escape') setEditing(false);
                }}
              />
              <button
                type="button"
                className="m-btn m-btn-primary m-btn-sm"
                disabled={renaming || !titleDraft.trim()}
                onClick={() => void rename()}
              >
                保存
              </button>
            </div>
          ) : (
            <>
              <div className="m-topbar-name">{work.title}</div>
              <div className="m-topbar-sub">
                {work.trackTitle ?? '伴奏已删除'} · {formatDateTime(work.createdAt)}
              </div>
            </>
          )}
        </div>
      </div>

      {error && <div className="m-alert m-alert-error">{error}</div>}

      {work.status === 'mixing' && (
        <div className="m-result-card">
          <div className="m-saving">
            <span className="spin" />
            正在合成 MP3…
          </div>
          <p className="m-notes">几秒就好。可以先去选下一首，合成完了回来再听。</p>
        </div>
      )}

      {work.status === 'failed' && (
        <div className="m-result-card">
          <div className="m-alert m-alert-error">合成失败：{work.error ?? '未知原因'}</div>
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-record"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? '正在重试…' : '重试合成'}
          </button>
        </div>
      )}

      {work.status === 'ready' && (
        <div className="m-result-card">
          <AudioPlayer src={workAudioUrl(work.id, work.updatedAt)} />
          <dl className="m-meta">
            <div>
              <dt>时长</dt>
              <dd>{formatDuration(work.vocalDuration)}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{work.sizeBytes ? formatBytes(work.sizeBytes) : '--'}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="m-rec-actions">
        {work.trackId && (
          <Link className="m-btn m-btn-primary m-btn-record" to={`/m/work/${work.id}/edit`}>
            调整效果
          </Link>
        )}
        {!editing && (
          <button
            type="button"
            className="m-btn m-btn-ghost m-btn-record"
            onClick={() => {
              setTitleDraft(work.title);
              setEditing(true);
            }}
          >
            改名
          </button>
        )}
        <button type="button" className="m-btn m-btn-ghost m-btn-record" onClick={() => void remove()}>
          删除
        </button>
      </div>

      <div className="m-rec-actions">
        <Link className="m-btn m-btn-primary m-btn-record" to="/m">
          再唱一首
        </Link>
        <Link className="m-btn m-btn-ghost m-btn-record" to="/m">
          返回首页
        </Link>
      </div>

      {!work.trackId && (
        <p className="m-notes">这个作品的伴奏已被删除：成品 MP3 还能播放，但不能重新合成。</p>
      )}
    </div>
  );
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MixParams } from '../../../shared/types';
import { api, trackMediaUrl, workVocalUrl, type WorkListItem } from '../api';
import { PreviewEngine } from '../audio/preview';
import { confirmAction } from '../components/ConfirmDialog';
import { toast } from '../components/ToastStack';
import { LivePreview, type PreviewStatus } from '../components/LivePreview';
import { MixPanel } from '../components/MixPanel';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';
import { errorMessage, formatDateTime, formatDuration } from '../utils';

/**
 * 作品编辑页：单列列表式排版 —— 实时试听 → 效果调整。
 *
 * 成品 MP3 的播放/下载都在作品库列表页；这里只负责「试听 + 调参 + 合成」，
 * 点「合成」发一次混音请求后直接返回作品库（定位到这首作品），
 * 在列表里等「正在合成… → 已就绪」即可。
 *
 * 排版硬要求：**所有元素一屏放完，不出滚动条**。做法见 styles.css 的
 * 「作品编辑页：一屏放完」一节 —— 紧凑排版 + 按视口高度逐级压缩，
 * 不锁高度也不裁内容（锁 height + overflow:hidden 会在矮窗口上把「合成」裁掉）。
 */
export default function WorkDetailPage() {
  const { t, locale } = useI18n();
  const { workId = '' } = useParams();
  const navigate = useNavigate();

  const [work, setWork] = useState<WorkListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  /** 合成请求 in-flight（按钮 loading 用）；控件不被它禁用，试听随时可调 */
  const [busy, setBusy] = useState(false);

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
    if (!work || !work.trackId || previewRef.current || previewStatus === 'loading') return null;
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
      setLoadError(errorMessage(err, t('detail.loadFailed')));
    }
  }, [workId, t]);

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
      setActionError(errorMessage(err, t('detail.mixFailed')));
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
      toast.ok(t('detail.renamed'));
      await load();
    } catch (err) {
      setActionError(errorMessage(err, t('detail.renameFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!work) return;
    const confirmed = await confirmAction({
      title: t('detail.delete.title'),
      message: t('detail.delete.message', { title: work.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      navigate('/works');
    } catch (err) {
      setActionError(errorMessage(err, t('detail.deleteFailed')));
    }
  };

  /** 撤销上一步分段重录：换回重录前的干声，并自动重新混音（只回退一级） */
  const handleUndoRetake = async () => {
    if (!work) return;
    const confirmed = await confirmAction({
      title: t('detail.undoRetake.title'),
      message: t('detail.undoRetake.message'),
      confirmText: t('detail.undoRetake.confirm'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.undoRetake(work.id);
      // 状态已翻成 mixing；load 一次让徽章和轮询跟上
      await load();
    } catch (err) {
      setActionError(errorMessage(err, t('detail.undoRetakeFailed')));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div>
        <div className="alert alert-error">{loadError}</div>
        <Link className="btn" to="/works">
          {t('detail.back')}
        </Link>
      </div>
    );
  }

  if (!work) return <div className="empty-state">{t('detail.loading')}</div>;

  const mixing = work.status === 'mixing';

  return (
    <div className="detail-page">
      <div className="page-head detail-head">
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <div className="detail-title-row">
              <span className="detail-title-chip">🎤</span>
              <input
                className="text-input"
                style={{ flex: '1 1 auto', maxWidth: 420 }}
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
                {t('common.save')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="detail-title-row">
              <span className="detail-title-chip">🎤</span>
              <h1 className="page-title">{work.title}</h1>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setTitleDraft(work.title);
                  setEditing(true);
                }}
              >
                {t('detail.rename')}
              </button>
            </div>
          )}
          <div className="detail-sub-row" style={{ marginTop: 6 }}>
            <p className="page-sub" style={{ margin: 0 }}>
              {work.trackTitle ? `${t('detail.track.label', { title: work.trackTitle })} · ` : ''}
              {t('detail.duration.label', { duration: formatDuration(work.vocalDuration) })} ·{' '}
              {formatDateTime(work.createdAt, locale)}
            </p>
            {/* 成品 MP3 的徽章跟着状态走：唱完刚落页时能看到初始混音的进度 */}
            {mixing ? (
              <span className="badge badge-work">
                <span className="spin" style={{ borderTopColor: 'var(--accent-2)' }} />
                {t('detail.status.mixing')}
              </span>
            ) : work.status === 'ready' ? (
              <span className="badge badge-ok">{t('common.ready')}</span>
            ) : null}
          </div>
        </div>
        <div className="row">
          <Link className="btn btn-ghost" to="/works">
            {t('detail.back')}
          </Link>
          {/* 伴奏被删的作品不能再混音，重录（拼完要重新混音）同理不给入口 */}
          {work.trackId && (
            <Link className="btn" to={`/works/${work.id}/retake`}>
              {t('detail.retake')}
            </Link>
          )}
          {work.hasPrevVocal && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void handleUndoRetake()}
              title={t('detail.undoRetake.hint')}
            >
              {t('detail.undoRetake.title')}
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}>
            {t('common.delete')}
          </button>
        </div>
      </div>

      {actionError && <div className="alert alert-error">{actionError}</div>}

      {work.status === 'failed' && (
        <div className="alert alert-error">
          {t('detail.mixFailedReason', { reason: work.error ?? t('common.unknown') })}
          <br />
          {t('detail.mixFailedHints')}
        </div>
      )}

      {/* 伴奏被删掉的作品：干声和成品 MP3 都还在，但没有伴奏就不能再混音 */}
      {!work.trackId && (
        <div className="alert alert-warn">{t('detail.trackDeleted')}</div>
      )}

      {work.trackId && (
        <div className="detail-body">
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
          />
        </div>
      )}
    </div>
  );
}

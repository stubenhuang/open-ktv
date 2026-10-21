//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, workAudioUrl, type WorkListItem } from '../../api';
import { AudioPlayer } from '../../components/AudioPlayer';
import { confirmAction } from '../../components/ConfirmDialog';
import { toast } from '../../components/ToastStack';
import { usePolling } from '../../hooks/usePolling';
import { useI18n } from '../../i18n';
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
  const { t, locale } = useI18n();
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
        if (!cancelled) setError(errorMessage(err, t('mobile.load_work_failed')));
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
        .catch((err: unknown) => setError(errorMessage(err, t('mobile.refresh_failed'))));
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
      setError(errorMessage(err, t('mobile.retry_mix_failed')));
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
      toast.ok(t('mobile.renamed'));
      setWork(await api.getWork(work.id));
    } catch (err) {
      setError(errorMessage(err, t('mobile.rename_failed')));
    } finally {
      setRenaming(false);
    }
  };

  const remove = async () => {
    if (!work) return;
    const confirmed = await confirmAction({
      title: t('mobile.delete_work_title'),
      message: t('mobile.delete_work_message', { title: work.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      toast.ok(t('mobile.deleted'));
      navigate('/m/works');
    } catch (err) {
      setError(errorMessage(err, t('mobile.delete_failed')));
    }
  };

  if (error && !work) {
    return (
      <div className="m-page">
        <div className="m-topbar">
          <Link className="m-back" to="/m">
            {t('mobile.back')}
          </Link>
        </div>
        <div className="m-alert m-alert-error">{error}</div>
      </div>
    );
  }

  if (!work) {
    return (
      <div className="m-page">
        <div className="m-empty">{t('mobile.loading')}</div>
      </div>
    );
  }

  return (
    <div className="m-page">
      <div className="m-topbar">
        <Link className="m-back" to="/m/works">
          {t('mobile.back')}
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
                {t('common.save')}
              </button>
            </div>
          ) : (
            <>
              <div className="m-topbar-name">{work.title}</div>
              <div className="m-topbar-sub">
                {work.trackTitle ?? t('mobile.works.track_deleted')} ·{' '}
                {formatDateTime(work.createdAt, locale)}
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
            {t('mobile.mixing_mp3')}
          </div>
          <p className="m-notes">{t('mobile.mixing_hint')}</p>
        </div>
      )}

      {work.status === 'failed' && (
        <div className="m-result-card">
          <div className="m-alert m-alert-error">
            {t('mobile.mix_failed', { reason: work.error ?? t('components.unknown_reason') })}
          </div>
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-record"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? t('mobile.retrying') : t('mobile.retry_mix')}
          </button>
        </div>
      )}

      {work.status === 'ready' && (
        <div className="m-result-card">
          <AudioPlayer src={workAudioUrl(work.id, work.updatedAt)} />
          <dl className="m-meta">
            <div>
              <dt>{t('common.duration')}</dt>
              <dd>{formatDuration(work.vocalDuration)}</dd>
            </div>
            <div>
              <dt>{t('common.size')}</dt>
              <dd>{work.sizeBytes ? formatBytes(work.sizeBytes, locale) : '--'}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="m-rec-actions">
        {work.trackId && (
          <Link className="m-btn m-btn-primary m-btn-record" to={`/m/work/${work.id}/edit`}>
            {t('mobile.adjust_effects')}
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
            {t('mobile.rename')}
          </button>
        )}
        <button type="button" className="m-btn m-btn-ghost m-btn-record" onClick={() => void remove()}>
          {t('common.delete')}
        </button>
      </div>

      <div className="m-rec-actions">
        <Link className="m-btn m-btn-primary m-btn-record" to="/m">
          {t('mobile.sing_another')}
        </Link>
        <Link className="m-btn m-btn-ghost m-btn-record" to="/m">
          {t('mobile.back_home')}
        </Link>
      </div>

      {!work.trackId && <p className="m-notes">{t('mobile.track_deleted_note')}</p>}
    </div>
  );
}

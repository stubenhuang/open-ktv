//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, trackMediaUrl, type TrackListItem } from '../api';
import { AudioPlayer } from '../components/AudioPlayer';
import { confirmAction } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { TrackSkeletonList } from '../components/Skeleton';
import { toast } from '../components/ToastStack';
import { TrackEditDialog } from '../components/TrackEditDialog';
import { UploadDialog, type UploadDraft } from '../components/UploadDialog';
import { usePolling } from '../hooks/usePolling';
import { errorMessage, formatBytes, formatDuration, isAudioFile, isLyricsFileName } from '../utils';
import { useI18n } from '../i18n';

interface UploadItem {
  key: string;
  name: string;
  size: number;
  progress: number;
  error: string | null;
  done: boolean;
}

let uploadKeySeed = 0;

/** 列表排序方式 */
type SortBy = 'recent' | 'title' | 'duration';

export default function LibraryPage() {
  const { t, fmt, plural, locale } = useI18n();
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 删除伴奏后的一次性提示（保留了几个作品这类事后才需要知道的事） */
  const [notice, setNotice] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** 正在编辑的伴奏；null = 编辑弹窗关着（表单在弹窗里，见 TrackEditDialog） */
  const [editingTrack, setEditingTrack] = useState<TrackListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 上传弹窗；null = 关着。打开时的初始选择也挂在它上面（拖拽预填） */
  const [dialog, setDialog] = useState<UploadDraft | null>(null);
  /** 列表关键字过滤（纯客户端：曲库就自己家这几首，不值得为它打接口） */
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('recent');

  const load = useCallback(async () => {
    try {
      const list = await api.listTracks();
      setTracks(list);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t('library.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 只有在真的有伴奏在转码时才轮询
  const hasProcessing = tracks.some((track) => track.status === 'processing');
  usePolling(() => void load(), 1500, hasProcessing);

  const patchUpload = (key: string, patch: Partial<UploadItem>) => {
    setUploads((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  /** 关键字 + 排序后的可见列表。歌名排序走 localeCompare 的当前语言规则，用户找歌的直觉跟界面语言一致 */
  const visibleTracks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? tracks.filter(
          (track) =>
            track.title.toLowerCase().includes(keyword) ||
            (track.artist ?? '').toLowerCase().includes(keyword),
        )
      : tracks;
    if (sortBy === 'title') {
      return [...filtered].sort((a, b) => a.title.localeCompare(b.title, locale));
    }
    if (sortBy === 'duration') {
      return [...filtered].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    }
    return filtered;
  }, [tracks, query, sortBy, locale]);

  /**
   * 上传一批伴奏（弹窗提交后调这里）。
   *
   * 串行上传：同时传几个大文件只会互相拖慢，还容易让转码队列排长队。
   * 歌词只跟第一个音频走 —— 多选音频时弹窗已经禁用了歌词选择。
   */
  const handleUpload = useCallback(
    async (audioFiles: File[], lyricsFile: File | null) => {
      setDialog(null);
      const list = audioFiles;
      if (list.length === 0) return;

      const created: UploadItem[] = list.map((file) => {
        uploadKeySeed += 1;
        return {
          key: `upload-${uploadKeySeed}`,
          name: file.name,
          size: file.size,
          progress: 0,
          error: null,
          done: false,
        };
      });
      setUploads((items) => [...created, ...items]);

      let succeeded = 0;
      let failed = 0;

      for (let index = 0; index < list.length; index += 1) {
        const file = list[index]!;
        const item = created[index]!;
        try {
          const uploaded = await api.uploadTrack(file, (ratio) =>
            patchUpload(item.key, { progress: ratio }),
          );
          patchUpload(item.key, { progress: 1, done: true });
          succeeded += 1;
          // 歌词跟着第一个音频一起入库；失败只记在这一项上，不波及音频本身
          if (index === 0 && lyricsFile) {
            try {
              await api.uploadLyrics(uploaded.id, lyricsFile);
            } catch (err) {
              patchUpload(item.key, {
                error: t('library.upload.lyricsFailed', { reason: errorMessage(err) }),
              });
            }
          }
        } catch (err) {
          failed += 1;
          patchUpload(item.key, { error: errorMessage(err, t('library.upload.failed')) });
        }
        void load();
      }

      // 成功的条目 2.4s 后自动消退（失败的留着，要用户自己关）
      for (const item of created) {
        window.setTimeout(() => {
          // 过滤时重读最新状态：这一项若在消退前刚报了错，就继续留着
          setUploads((items) => items.filter((one) => one.key !== item.key || one.error !== null));
        }, 2400);
      }

      if (succeeded > 0) {
        toast.ok(
          failed > 0
            ? plural('library.upload.summary.partial', succeeded, { failed: fmt.integer(failed) })
            : plural('library.upload.summary.done', succeeded),
        );
      }
    },
    [load, t, fmt, plural],
  );

  /** 拖到上传区的文件：音频进弹窗的音频列表，.lrc/.txt 进歌词，其它的只提示不拦 */
  const openDialogWithFiles = (files: File[]) => {
    const audio = files.filter(isAudioFile);
    const lyrics = files.filter((file) => isLyricsFileName(file.name));
    const ignored = files.filter((file) => !isAudioFile(file) && !isLyricsFileName(file.name));

    const notes: string[] = [];
    if (ignored.length > 0) {
      notes.push(
        t('library.drop.ignored', {
          count: fmt.integer(ignored.length),
          files: fmt.list(ignored.map((file) => file.name)),
        }),
      );
    }
    if (lyrics.length > 1) {
      notes.push(t('library.drop.lyricsOnlyFirst', { name: lyrics[0]!.name }));
    }

    setDialog({ audio, lyrics: lyrics[0] ?? null, note: notes.join(t('library.drop.noteSeparator')) || null });
  };

  const handleDelete = async (track: TrackListItem) => {
    // 作品与伴奏解耦：有作品也照删。确认框里说清作品会怎样，别让用户事后才发现。
    const worksNote =
      track.workCount > 0 ? plural('library.delete.worksNote', track.workCount) : '';
    const confirmed = await confirmAction({
      title: t('library.delete.title'),
      message: t('library.delete.message', { title: track.title, worksNote }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    setBusyId(track.id);
    try {
      const result = await api.deleteTrack(track.id);
      if (previewId === track.id) setPreviewId(null);
      setNotice(
        result.keptWorks > 0
          ? plural('library.delete.notice', result.keptWorks, { title: track.title })
          : null,
      );
      toast.ok(t('library.delete.done', { title: track.title }));
      await load();
    } catch (err) {
      setError(errorMessage(err, t('library.delete.failed')));
    } finally {
      setBusyId(null);
    }
  };

  const handleRetry = async (track: TrackListItem) => {
    setBusyId(track.id);
    setError(null);
    try {
      await api.retryTrack(track.id);
      await load();
    } catch (err) {
      setError(errorMessage(err, t('library.retry.failed')));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {t('library.title')}{' '}
            <span className="badge badge-kind">{plural('library.trackCount', tracks.length)}</span>
          </h1>
          <p className="page-sub">{t('library.subtitle')}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDialog({ audio: [], lyrics: null, note: null })}
        >
          {t('library.upload')}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 10 }}
            onClick={() => setNotice(null)}
          >
            {t('common.ok')}
          </button>
        </div>
      )}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={t('library.uploadAria')}
        onClick={() => setDialog({ audio: [], lyrics: null, note: null })}
        onKeyDown={(event) => {
          // 键盘也要能打开上传区（role=button 的约定：Enter / 空格触发）
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setDialog({ audio: [], lyrics: null, note: null });
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          openDialogWithFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="dropzone-icon" aria-hidden="true">
          🎧
        </div>
        <div className="dropzone-title">{t('library.dropzone.title')}</div>
        <div className="small faint">{t('library.dropzone.hint')}</div>
      </div>

      {dialog && (
        <UploadDialog
          draft={dialog}
          onClose={() => setDialog(null)}
          onSubmit={(audio, lyrics) => void handleUpload(audio, lyrics)}
        />
      )}

      {editingTrack && (
        <TrackEditDialog
          track={editingTrack}
          onClose={() => setEditingTrack(null)}
          onSaved={() => void load()}
        />
      )}

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((item) => (
            <div key={item.key} className="upload-item">
              <span className="upload-item-name">
                {item.name}
              </span>
              <span className="faint small mono">{formatBytes(item.size, locale)}</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </div>
              <span className="small upload-item-status">
                {item.error ? (
                  <span style={{ color: 'var(--danger)' }}>{item.error}</span>
                ) : item.done ? (
                  <span style={{ color: 'var(--ok)' }}>{t('library.upload.itemDone')}</span>
                ) : (
                  t('library.upload.itemProgress', { percent: fmt.percent(item.progress) })
                )}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('library.upload.dismissAria', { name: item.name })}
                onClick={() => setUploads((items) => items.filter((one) => one.key !== item.key))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 工具栏：关键字过滤 + 排序。曲库攒到几十首之后，翻列表找歌是高频动作 */}
      {!loading && tracks.length > 0 && (
        <div className="list-toolbar">
          <input
            className="text-input"
            type="search"
            value={query}
            placeholder={t('library.filter.placeholder')}
            aria-label={t('library.filter.aria')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select-input"
            value={sortBy}
            aria-label={t('library.sort.aria')}
            onChange={(event) => setSortBy(event.target.value as SortBy)}
          >
            <option value="recent">{t('library.sort.recent')}</option>
            <option value="title">{t('library.sort.title')}</option>
            <option value="duration">{t('library.sort.duration')}</option>
          </select>
          <span className="list-count">
            {visibleTracks.length === tracks.length
              ? plural('library.trackCount', tracks.length)
              : t('library.filter.count', {
                  shown: fmt.integer(visibleTracks.length),
                  total: fmt.integer(tracks.length),
                })}
          </span>
        </div>
      )}

      {loading ? (
        <TrackSkeletonList />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon="🎵"
          title={t('library.empty.title')}
          description={t('library.empty.description')}
          action={
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setDialog({ audio: [], lyrics: null, note: null })}
              >
                {t('library.empty.uploadFirst')}
              </button>
              <Link className="btn" to="/discover">
                {t('library.empty.goDiscover')}
              </Link>
            </>
          }
        />
      ) : visibleTracks.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={t('library.filter.noMatch.title')}
          description={t('library.filter.noMatch.description', { query: query.trim() })}
          action={
            <button type="button" className="btn" onClick={() => setQuery('')}>
              {t('library.filter.clear')}
            </button>
          }
        />
      ) : (
        <div className="track-list">
          {visibleTracks.map((track) => {
            const isPreviewing = previewId === track.id;

            return (
              <div key={track.id} className={`track-item${isPreviewing ? ' selected' : ''}`}>
                <div
                  className="track-kind"
                  title={t(track.kind === 'video' ? 'library.kind.video' : 'library.kind.audio')}
                >
                  {track.kind === 'video' ? '🎬' : '🎵'}
                </div>

                {/*
                  列表行只放「认出一首歌」需要的信息：名字、歌手、时长、大小、
                  有没有歌词、几个作品、处理状态。编辑（含歌词）在弹窗里 ——
                  见 TrackEditDialog；行内展开那套表单一行能撑到四百多像素。
                */}
                <div className="track-main">
                  <div className="track-title">{track.title}</div>
                  <div className="track-meta">
                    {track.artist && <span>{track.artist}</span>}
                    <span className="mono">{formatDuration(track.duration)}</span>
                    <span>{formatBytes(track.size, locale)}</span>
                    {track.hasLyrics && <span className="badge badge-ok">{t('library.hasLyrics')}</span>}
                    {track.workCount > 0 && (
                      <span className="badge badge-kind" title={t('library.worksBadge.title')}>
                        {plural('library.workCount', track.workCount)}
                      </span>
                    )}
                    {track.status === 'processing' && (
                      <span className="badge badge-work" title={t('library.processing.title')}>
                        {t('library.processing.progress', {
                          percent: fmt.percent(track.progress ?? 0),
                        })}
                      </span>
                    )}
                    {track.status === 'failed' && (
                      <span className="badge badge-fail" title={track.error ?? ''}>
                        {t('library.status.failed')}
                      </span>
                    )}
                  </div>
                  {track.status === 'failed' && track.error && (
                    <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
                      {track.error}
                    </div>
                  )}
                </div>

                <div className="track-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={track.status !== 'ready'}
                      onClick={() => setPreviewId(isPreviewing ? null : track.id)}
                    >
                      {isPreviewing ? t('library.stopPreview') : t('library.preview')}
                    </button>
                    <Link
                      className="btn btn-primary btn-sm"
                      to={`/sing/${track.id}`}
                      style={track.status !== 'ready' ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
                    >
                      {t('library.goSing')}
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditingTrack(track)}
                    >
                      {t('common.edit')}
                    </button>
                    {track.status === 'failed' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === track.id}
                        onClick={() => void handleRetry(track)}
                      >
                        {t('library.retry.button')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busyId === track.id}
                      onClick={() => void handleDelete(track)}
                    >
                      {t('common.delete')}
                    </button>
                </div>

                {isPreviewing && (
                  <div className="track-preview">
                    <AudioPlayer
                      src={trackMediaUrl(track.id)}
                      autoPlay
                      onEnded={() => setPreviewId(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

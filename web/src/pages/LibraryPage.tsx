import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LRC_LIMITS } from '../../../shared/types';
import { api, trackMediaUrl, type TrackListItem } from '../api';
import { usePolling } from '../hooks/usePolling';
import { errorMessage, formatBytes, formatDuration } from '../utils';

interface UploadItem {
  key: string;
  name: string;
  size: number;
  progress: number;
  error: string | null;
  done: boolean;
}

let uploadKeySeed = 0;

export default function LibraryPage() {
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editArtist, setEditArtist] = useState('');
  const [editLyrics, setEditLyrics] = useState('');
  const [editLyricsOffsetMs, setEditLyricsOffsetMs] = useState(0);
  /**
   * 歌词框是否被用户动过。
   * 列表接口不下发歌词正文（省流量），编辑时要单独拉一次详情；
   * 拉取失败或还没回来时绝不能拿空串去覆盖 —— 那等于把歌词删了。
   */
  const [lyricsDirty, setLyricsDirty] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lyricsInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listTracks();
      setTracks(list);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, '加载伴奏列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 只有在真的有伴奏在转码时才轮询
  const hasProcessing = tracks.some((track) => track.status === 'processing');
  usePolling(() => void load(), 1500, hasProcessing);

  const patchUpload = (key: string, patch: Partial<UploadItem>) => {
    setUploads((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
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

      // 串行上传：同时传几个大文件只会互相拖慢，还容易让转码队列排长队
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index]!;
        const item = created[index]!;
        try {
          await api.uploadTrack(file, (ratio) => patchUpload(item.key, { progress: ratio }));
          patchUpload(item.key, { progress: 1, done: true });
        } catch (err) {
          patchUpload(item.key, { error: errorMessage(err, '上传失败') });
        }
        void load();
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [load],
  );

  const handleDelete = async (track: TrackListItem) => {
    if (!window.confirm(`确定删除伴奏「${track.title}」吗？原文件也会一起删掉。`)) return;
    setBusyId(track.id);
    try {
      await api.deleteTrack(track.id);
      if (previewId === track.id) setPreviewId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, '删除失败'));
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
      setError(errorMessage(err, '重试失败'));
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = async (track: TrackListItem) => {
    setEditingId(track.id);
    setEditTitle(track.title);
    setEditArtist(track.artist ?? '');
    setEditLyrics('');
    setEditLyricsOffsetMs(track.lyricsOffsetMs);
    setLyricsDirty(false);

    // 歌词正文不在列表里，要单独拉一次详情
    if (!track.hasLyrics) return;
    setBusyId(track.id);
    try {
      const detail = await api.getTrack(track.id);
      // 用户可能已经切到别的伴奏了，别把歌词塞错地方
      if (detail.id === track.id) setEditLyrics(detail.lyrics ?? '');
    } catch (err) {
      setError(errorMessage(err, '加载歌词失败'));
    } finally {
      setBusyId(null);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusyId(editingId);
    try {
      await api.updateTrack(editingId, {
        title: editTitle,
        artist: editArtist,
        // 只有用户真的动过歌词才提交，避免用空框把已有歌词冲掉
        ...(lyricsDirty ? { lyrics: editLyrics } : {}),
        lyricsOffsetMs: editLyricsOffsetMs,
      });
      setEditingId(null);
      setLyricsDirty(false);
      await load();
    } catch (err) {
      setError(errorMessage(err, '保存失败'));
    } finally {
      setBusyId(null);
    }
  };

  /** 选一个 .lrc 直接入库；成功后就地回填文本框，方便继续微调 */
  const handleLyricsFile = async (file: File) => {
    if (!editingId) return;
    setBusyId(editingId);
    setError(null);
    try {
      const updated = await api.uploadLyrics(editingId, file);
      setEditLyrics(updated.lyrics ?? '');
      setLyricsDirty(false);
      await load();
    } catch (err) {
      setError(errorMessage(err, '上传歌词失败'));
    } finally {
      setBusyId(null);
      if (lyricsInputRef.current) lyricsInputRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">伴奏库</h1>
          <p className="page-sub">
            上传音频或视频伴奏（支持 mkv / avi / flv 等，浏览器放不了的会自动转码）。单个文件最大 1GB。
          </p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFiles(event.dataTransfer.files);
        }}
      >
        <div className="dropzone-title">把伴奏文件拖到这里，或点击选择</div>
        <div className="small faint">
          支持 mp3 / wav / flac / m4a / mp4 / mkv / webm / avi / mov / flv 等，可一次选多个
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="audio/*,video/*,.mkv,.flv,.avi,.ts,.m4a,.flac,.wav,.ape"
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) void handleFiles(event.target.files);
          }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((item) => (
            <div key={item.key} className="upload-item">
              <span style={{ minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
              <span className="faint small mono">{formatBytes(item.size)}</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </div>
              <span className="small" style={{ minWidth: 84, textAlign: 'right' }}>
                {item.error ? (
                  <span style={{ color: 'var(--danger)' }}>{item.error}</span>
                ) : item.done ? (
                  '已上传'
                ) : (
                  `上传 ${Math.round(item.progress * 100)}%`
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="empty-state">正在加载…</div>
      ) : tracks.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 20 }}>
          还没有伴奏。先上传一首，然后就能开唱了。
        </div>
      ) : (
        <div className="track-list">
          {tracks.map((track) => {
            const isEditing = editingId === track.id;
            const isPreviewing = previewId === track.id;

            return (
              <div key={track.id} className={`track-item${isPreviewing ? ' selected' : ''}`}>
                <div className="track-kind" title={track.kind === 'video' ? '视频伴奏' : '音频伴奏'}>
                  {track.kind === 'video' ? '🎬' : '🎵'}
                </div>

                <div className="track-main">
                  {isEditing ? (
                    <div className="edit-form edit-form-stack">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <input
                          className="text-input"
                          style={{ flex: '1 1 200px' }}
                          value={editTitle}
                          placeholder="歌名"
                          onChange={(event) => setEditTitle(event.target.value)}
                          autoFocus
                        />
                        <input
                          className="text-input"
                          style={{ flex: '0 1 150px' }}
                          value={editArtist}
                          placeholder="歌手"
                          onChange={(event) => setEditArtist(event.target.value)}
                        />
                      </div>

                      <div className="field" style={{ marginTop: 10 }}>
                        <div className="field-label">
                          <span>歌词（LRC）</span>
                          <span className="faint small">
                            {track.hasLyrics ? '已有歌词，改动会覆盖' : '还没有歌词'}
                          </span>
                        </div>
                        <textarea
                          className="text-input lyrics-textarea"
                          value={editLyrics}
                          placeholder={'每行都要带时间戳，例如：\n[00:12.00]第一句\n[00:16.50]第二句'}
                          onChange={(event) => {
                            setEditLyrics(event.target.value);
                            setLyricsDirty(true);
                          }}
                        />
                        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busyId === track.id}
                            onClick={() => lyricsInputRef.current?.click()}
                          >
                            选择 .lrc 文件
                          </button>
                          {track.hasLyrics && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setEditLyrics('');
                                setLyricsDirty(true);
                              }}
                            >
                              清空歌词
                            </button>
                          )}
                          <input
                            ref={lyricsInputRef}
                            type="file"
                            accept=".lrc,.txt"
                            style={{ display: 'none' }}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void handleLyricsFile(file);
                            }}
                          />
                        </div>
                      </div>

                      <div className="field" style={{ marginTop: 10 }}>
                        <div className="field-label">
                          <span>歌词对轴微调</span>
                          <span className="field-value">
                            {editLyricsOffsetMs > 0 ? '+' : ''}
                            {editLyricsOffsetMs} ms
                          </span>
                        </div>
                        <input
                          type="range"
                          min={LRC_LIMITS.offsetMs.min}
                          max={LRC_LIMITS.offsetMs.max}
                          step={LRC_LIMITS.offsetMs.step}
                          value={editLyricsOffsetMs}
                          onChange={(event) => setEditLyricsOffsetMs(Number(event.target.value))}
                        />
                        <div className="small faint">正值 = 歌词更晚显示（歌词跑在伴奏前面时用）。</div>
                      </div>

                      <div className="row" style={{ gap: 8, marginTop: 12 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busyId === track.id}
                          onClick={() => void saveEdit()}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditingId(null);
                            setLyricsDirty(false);
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="track-title">{track.title}</div>
                      <div className="track-meta">
                        {track.artist && <span>{track.artist}</span>}
                        <span className="mono">{formatDuration(track.duration)}</span>
                        <span>{formatBytes(track.size)}</span>
                        {track.proxyKind !== 'none' && <span className="badge badge-kind">已转码</span>}
                        {track.hasLyrics && <span className="badge badge-ok">有歌词</span>}
                        {track.source === 'library' && <span className="badge badge-kind">点歌</span>}
                        {track.status === 'processing' && (
                          <span className="badge badge-work">
                            转码中 {Math.round((track.progress ?? 0) * 100)}%
                          </span>
                        )}
                        {track.status === 'failed' && (
                          <span className="badge badge-fail" title={track.error ?? ''}>
                            处理失败
                          </span>
                        )}
                      </div>
                      {track.status === 'failed' && track.error && (
                        <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
                          {track.error}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {!isEditing && (
                  <div className="track-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={track.status !== 'ready'}
                      onClick={() => setPreviewId(isPreviewing ? null : track.id)}
                    >
                      {isPreviewing ? '停止试听' : '试听'}
                    </button>
                    <Link
                      className="btn btn-primary btn-sm"
                      to={`/sing/${track.id}`}
                      style={track.status !== 'ready' ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
                    >
                      去演唱
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void startEdit(track)}
                    >
                      编辑
                    </button>
                    {track.status === 'failed' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busyId === track.id}
                        onClick={() => void handleRetry(track)}
                      >
                        重试处理
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busyId === track.id}
                      onClick={() => void handleDelete(track)}
                    >
                      删除
                    </button>
                  </div>
                )}

                {isPreviewing && (
                  <div style={{ width: '100%' }}>
                    <audio
                      src={trackMediaUrl(track.id)}
                      controls
                      autoPlay
                      onEnded={() => setPreviewId(null)}
                      style={{ width: '100%', marginTop: 10, height: 34 }}
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

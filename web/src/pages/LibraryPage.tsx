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

  /** 关键字 + 排序后的可见列表。歌名按拼音排（localeCompare 的 zh 排序），中文用户找歌更直觉 */
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
      return [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    }
    if (sortBy === 'duration') {
      return [...filtered].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    }
    return filtered;
  }, [tracks, query, sortBy]);

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
              patchUpload(item.key, { error: `伴奏已上传，但歌词没上去：${errorMessage(err)}` });
            }
          }
        } catch (err) {
          failed += 1;
          patchUpload(item.key, { error: errorMessage(err, '上传失败') });
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
            ? `已上传 ${succeeded} 个伴奏，${failed} 个失败`
            : `已上传 ${succeeded} 个伴奏，可以在下面试听 / 演唱了`,
        );
      }
    },
    [load],
  );

  /** 拖到上传区的文件：音频进弹窗的音频列表，.lrc/.txt 进歌词，其它的只提示不拦 */
  const openDialogWithFiles = (files: File[]) => {
    const audio = files.filter(isAudioFile);
    const lyrics = files.filter((file) => isLyricsFileName(file.name));
    const ignored = files.filter((file) => !isAudioFile(file) && !isLyricsFileName(file.name));

    const notes: string[] = [];
    if (ignored.length > 0) {
      notes.push(
        `忽略了 ${ignored.length} 个文件：${ignored.map((file) => file.name).join('、')}` +
          '（伴奏库只收音频和 .lrc 歌词）',
      );
    }
    if (lyrics.length > 1) {
      notes.push(`歌词只取了第一个：${lyrics[0]!.name}`);
    }

    setDialog({ audio, lyrics: lyrics[0] ?? null, note: notes.join('；') || null });
  };

  const handleDelete = async (track: TrackListItem) => {
    // 作品与伴奏解耦：有作品也照删。确认框里说清作品会怎样，别让用户事后才发现。
    const worksNote =
      track.workCount > 0
        ? `\n它下面的 ${track.workCount} 个作品会保留（成品 MP3 仍可播放 / 下载），但不能再调整效果或重新合成。`
        : '';
    const confirmed = await confirmAction({
      title: '删除伴奏',
      message: `确定删除伴奏「${track.title}」吗？原文件也会一起删掉。${worksNote}`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    setBusyId(track.id);
    try {
      const result = await api.deleteTrack(track.id);
      if (previewId === track.id) setPreviewId(null);
      setNotice(
        result.keptWorks > 0
          ? `已删除伴奏「${track.title}」，保留 ${result.keptWorks} 个作品（成品仍可播放 / 下载，但不能重新合成）。`
          : null,
      );
      toast.ok(`已删除伴奏「${track.title}」`);
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

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            伴奏库 <span className="badge badge-kind">{tracks.length} 首</span>
          </h1>
          <p className="page-sub">上传伴奏、带上歌词，就能去演唱；没有想唱的，去点歌台搜一首。</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDialog({ audio: [], lyrics: null, note: null })}
        >
          上传伴奏
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
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
            知道了
          </button>
        </div>
      )}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="上传伴奏：点击选择文件，或把音频文件拖到这里"
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
        <div className="dropzone-title">把音频文件拖到这里，或点击选择</div>
        <div className="small faint">
          支持 mp3 / wav / flac / m4a 等常见音频，可一次多选；.lrc 歌词可以一起拖进来
        </div>
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
              <span className="faint small mono">{formatBytes(item.size)}</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </div>
              <span className="small upload-item-status">
                {item.error ? (
                  <span style={{ color: 'var(--danger)' }}>{item.error}</span>
                ) : item.done ? (
                  <span style={{ color: 'var(--ok)' }}>✓ 已上传</span>
                ) : (
                  `上传中 ${Math.round(item.progress * 100)}%`
                )}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`收起 ${item.name} 的上传状态`}
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
        <div className="library-toolbar">
          <input
            className="text-input"
            type="search"
            value={query}
            placeholder="按歌名 / 歌手过滤…"
            aria-label="按歌名或歌手过滤伴奏"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select-input"
            value={sortBy}
            aria-label="排序方式"
            onChange={(event) => setSortBy(event.target.value as SortBy)}
          >
            <option value="recent">最近上传</option>
            <option value="title">按歌名</option>
            <option value="duration">按时长</option>
          </select>
          <span className="library-count">
            {visibleTracks.length === tracks.length
              ? `共 ${tracks.length} 首`
              : `${visibleTracks.length} / ${tracks.length} 首`}
          </span>
        </div>
      )}

      {loading ? (
        <TrackSkeletonList />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon="🎵"
          title="还没有伴奏"
          description="先上传一首，然后就能开唱了。也可以去点歌台看看有没有现成的。"
          action={
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setDialog({ audio: [], lyrics: null, note: null })}
              >
                上传第一首
              </button>
              <Link className="btn" to="/discover">
                去点歌台
              </Link>
            </>
          }
        />
      ) : visibleTracks.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="没有匹配的伴奏"
          description={`曲库里没有和「${query.trim()}」相关的歌名或歌手。`}
          action={
            <button type="button" className="btn" onClick={() => setQuery('')}>
              清空过滤
            </button>
          }
        />
      ) : (
        <div className="track-list">
          {visibleTracks.map((track) => {
            const isPreviewing = previewId === track.id;

            return (
              <div key={track.id} className={`track-item${isPreviewing ? ' selected' : ''}`}>
                <div className="track-kind" title={track.kind === 'video' ? '视频伴奏' : '音频伴奏'}>
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
                    <span>{formatBytes(track.size)}</span>
                    {track.hasLyrics && <span className="badge badge-ok">有歌词</span>}
                    {track.workCount > 0 && (
                      <span
                        className="badge badge-kind"
                        title="删除伴奏时这些作品会保留，但不能重新合成"
                      >
                        {track.workCount} 个作品
                      </span>
                    )}
                    {track.status === 'processing' && (
                      <span
                        className="badge badge-work"
                        title="正在转码成浏览器能直接播放的格式"
                      >
                        处理中 {Math.round((track.progress ?? 0) * 100)}%
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
                </div>

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
                      onClick={() => setEditingTrack(track)}
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

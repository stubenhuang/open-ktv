import { useEffect, useRef, useState } from 'react';
import { LRC_LIMITS } from '../../../shared/types';
import { api, type TrackListItem } from '../api';
import { toast } from './ToastStack';
import { errorMessage } from '../utils';

interface Props {
  /** 要编辑的伴奏（列表行快照） */
  track: TrackListItem;
  onClose: () => void;
  /** 保存成功（或歌词入库）后回调：让列表刷新 */
  onSaved: () => void | Promise<void>;
}

/**
 * 「编辑伴奏」弹窗：歌名 / 歌手 / 歌词 / 歌词对轴。
 *
 * 为什么从列表行里搬出来：这套表单（两个输入框 + 歌词文本框 + 三个歌词操作 +
 * 对轴滑块 + 保存取消）在行内展开会把一行撑到四百多像素，列表基本没法浏览；
 * 而且「翻列表找歌」和「给一首歌配歌词」本来就是两件事，混在一个组件里
 * 两边都受罪。现在列表行只留信息与四个动作，编辑全部收进这里。
 *
 * 行为与原行内编辑一致，两个关键语义不能丢：
 *  · 歌词正文不在列表接口里，进来时要单独拉一次详情；拉取失败或还没回来时
 *    绝不能拿空串覆盖 —— 那等于把歌词删了（lyricsDirty 就是为这个存在的）；
 *  · 只有用户真的动过歌词才提交 lyrics，避免用空框冲掉服务端的歌词。
 */
export function TrackEditDialog({ track, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? '');
  const [lyrics, setLyrics] = useState('');
  /** 歌词框是否被用户动过（见上面的注释） */
  const [lyricsDirty, setLyricsDirty] = useState(false);
  const [lyricsOffsetMs, setLyricsOffsetMs] = useState(track.lyricsOffsetMs);
  /** 歌词详情拉取中：文本框禁用并给提示，避免拿空串当「没有歌词」 */
  const [loadingLyrics, setLoadingLyrics] = useState(track.hasLyrics);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lyricsInputRef = useRef<HTMLInputElement>(null);

  // 打开时把焦点移进面板：屏幕阅读器接着就能念标题，Tab 也从面板里开始转
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Esc 关窗；弹窗开着时按 Esc 不该再去触发页面上的其它快捷键
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 歌词正文不在列表里，挂载时单独拉一次详情
  useEffect(() => {
    if (!track.hasLyrics) return;
    let cancelled = false;
    api
      .getTrack(track.id)
      .then((detail) => {
        if (cancelled) return;
        setLyrics(detail.lyrics ?? '');
        setLyricsOffsetMs(detail.lyricsOffsetMs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, '加载歌词失败'));
      })
      .finally(() => {
        if (!cancelled) setLoadingLyrics(false);
      });
    return () => {
      cancelled = true;
    };
  }, [track.id, track.hasLyrics]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateTrack(track.id, {
        title,
        artist,
        ...(lyricsDirty ? { lyrics } : {}),
        lyricsOffsetMs,
      });
      toast.ok('已保存');
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  /** 选一个 .lrc 直接入库；成功后就地回填文本框，方便继续微调 */
  const pickLyricsFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.uploadLyrics(track.id, file);
      setLyrics(updated.lyrics ?? '');
      setLyricsDirty(false);
      toast.ok('歌词已入库');
      await onSaved();
    } catch (err) {
      setError(errorMessage(err, '上传歌词失败'));
    } finally {
      setBusy(false);
      if (lyricsInputRef.current) lyricsInputRef.current.value = '';
    }
  };

  /** 按歌名/歌手问歌词源（酷狗）要一份 LRC；失败只提示，不动已有歌词 */
  const autoLyrics = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.fetchTrackLyrics(track.id);
      setLyrics(updated.lyrics ?? '');
      setLyricsDirty(false);
      toast.ok('已自动获取歌词');
      await onSaved();
    } catch (err) {
      setError(errorMessage(err, '自动获取歌词失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="app-modal"
      onMouseDown={(event) => {
        // 点遮罩（弹窗面板以外的区域）关窗；面板内部的点击不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="app-modal-panel edit-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="编辑伴奏"
        tabIndex={-1}
      >
        <div className="app-modal-head">
          <div>
            <div className="page-title" style={{ fontSize: 18 }}>
              编辑伴奏
            </div>
            <p className="page-sub" style={{ marginTop: 2 }}>
              改歌名歌手、贴歌词、微调歌词时间。
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="text-input"
            style={{ flex: '1 1 200px' }}
            value={title}
            placeholder="歌名"
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            className="text-input"
            style={{ flex: '0 1 150px' }}
            value={artist}
            placeholder="歌手"
            onChange={(event) => setArtist(event.target.value)}
          />
        </div>

        <div className="field">
          <div className="field-label">
            <span>歌词（LRC）</span>
            <span className="faint small">
              {track.hasLyrics ? '已有歌词，改动会覆盖' : '还没有歌词'}
            </span>
          </div>
          <textarea
            className="text-input lyrics-textarea"
            value={lyrics}
            disabled={loadingLyrics}
            placeholder={
              loadingLyrics
                ? '正在加载歌词…'
                : '每行都要带时间戳，例如：\n[00:12.00]第一句\n[00:16.50]第二句'
            }
            onChange={(event) => {
              setLyrics(event.target.value);
              setLyricsDirty(true);
            }}
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => lyricsInputRef.current?.click()}
            >
              选择 .lrc 文件
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => void autoLyrics()}
            >
              自动获取歌词
            </button>
            {(lyrics.length > 0 || track.hasLyrics) && !loadingLyrics && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  setLyrics('');
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
                if (file) void pickLyricsFile(file);
              }}
            />
          </div>
          <div className="small faint">自动获取：按歌名/歌手从酷狗匹配 LRC。</div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>歌词对轴</span>
            <span className="field-value">
              {lyricsOffsetMs > 0 ? '+' : ''}
              {lyricsOffsetMs} ms
            </span>
          </div>
          <input
            type="range"
            min={LRC_LIMITS.offsetMs.min}
            max={LRC_LIMITS.offsetMs.max}
            step={LRC_LIMITS.offsetMs.step}
            value={lyricsOffsetMs}
            onChange={(event) => setLyricsOffsetMs(Number(event.target.value))}
          />
          <div className="small faint">正值 = 歌词更晚出现；歌词跑在伴奏前面就往右拖。</div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? (
              <>
                <span className="spin" style={{ borderTopColor: '#fff' }} />
                保存中…
              </>
            ) : (
              '保存'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

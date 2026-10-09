import { useEffect, useRef, useState } from 'react';
import { formatBytes, isAudioFile, isLyricsFileName } from '../utils';

/** 音频文件选择框的 accept：只列音频，视频一概不出现 */
const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.wma,.ape,.aiff,.aif,.caf,.amr,.ac3,.dts,.wv,.tta';

/** 歌词文件选择框的 accept */
const LYRICS_ACCEPT = '.lrc,.txt';

/** 打开弹窗时带进来的初始选择（拖拽文件进来时预填用） */
export interface UploadDraft {
  /** 已经挑中的音频文件 */
  audio: File[];
  /** 已经挑中的歌词文件；null = 没选 */
  lyrics: File | null;
  /** 拖拽时被忽略的文件说明，显示在弹窗里 */
  note?: string | null;
}

interface Props {
  draft: UploadDraft;
  onClose: () => void;
  /** 点「开始上传」：音频（至少一个）+ 可选歌词 */
  onSubmit: (audio: File[], lyrics: File | null) => void | Promise<void>;
}

/** 一个可点的文件选择框（真正的 input 藏起来，样式自己画） */
function Picker({
  label,
  hint,
  accept,
  multiple = false,
  disabled = false,
  emptyText,
  onPick,
  children,
}: {
  label: string;
  hint?: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  emptyText: string;
  onPick: (files: File[]) => void;
  children?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="faint small">{hint}</span>}
      </div>
      <div
        className={`upload-picker${disabled ? ' disabled' : ''}`}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
      >
        {children ?? <span className="faint">{emptyText}</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // 立刻清空：同一个文件第二次选也要能触发 change
          if (inputRef.current) inputRef.current.value = '';
          if (files.length > 0) onPick(files);
        }}
      />
    </div>
  );
}

/**
 * 上传伴奏的二级弹窗：选音频（必填，可多选）+ 选歌词（可选）。
 *
 * 为什么要有这一层：以前点上传区直接把文件丢出去，用户没机会先确认选对了没有，
 * 也没法在传伴奏的同时把 .lrc 一起带上。现在选择、校验、去掉误选文件都在弹窗里完成，
 * 点「开始上传」才真的发请求。
 */
export function UploadDialog({ draft, onClose, onSubmit }: Props) {
  const [audioFiles, setAudioFiles] = useState<File[]>(draft.audio);
  const [lyricsFile, setLyricsFile] = useState<File | null>(draft.lyrics);
  /** 行内错误（选到了不支持的文件） */
  const [error, setError] = useState<string | null>(null);
  /** 行内提示（比如多选音频时歌词被撤下）—— 不是错误，说明发生了什么 */
  const [info, setInfo] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时把焦点移进面板：屏幕阅读器接着就能念标题，Tab 也从面板里开始转，
  // 不会先跑去背后那一页面的控件。（pointer 点击打开不会显示焦点环，
  // 键盘打开才会 —— :focus-visible 的默认行为）
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

  const pickAudio = (files: File[]) => {
    const accepted = files.filter(isAudioFile);
    const rejected = files.filter((file) => !isAudioFile(file));
    if (accepted.length > 0) {
      setAudioFiles((previous) => {
        const next = [...previous, ...accepted];
        // 歌词只能跟一个音频走：一变成多选就撤掉已选的歌词，别让它静默失效
        if (next.length > 1 && lyricsFile) {
          setLyricsFile(null);
          setInfo('一次传多个音频时不能同时指定歌词，已撤掉选中的歌词；可上传后在编辑里补。');
        }
        return next;
      });
      setError(null);
    }
    if (rejected.length > 0) {
      setError(
        `只支持音频文件，已忽略 ${rejected.map((file) => file.name).join('、')}` +
          '（视频伴奏请先提取音频）',
      );
    }
  };

  const pickLyrics = (files: File[]) => {
    const lyrics = files.filter((file) => isLyricsFileName(file.name));
    const rejected = files.filter((file) => !isLyricsFileName(file.name));
    if (lyrics.length > 0) {
      setLyricsFile(lyrics[0]!);
      setInfo(null);
      setError(null);
    }
    if (rejected.length > 0 || lyrics.length > 1) {
      setError('歌词只能选一个 .lrc / .txt 文件');
    }
  };

  const removeAudio = (index: number) => {
    setAudioFiles((previous) => previous.filter((_, i) => i !== index));
    setInfo(null);
  };

  const multiAudio = audioFiles.length > 1;
  const canSubmit = audioFiles.length > 0;

  return (
    <div
      className="upload-modal"
      onMouseDown={(event) => {
        // 点遮罩（弹窗面板以外的区域）关窗；面板内部的点击不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="upload-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="上传伴奏"
        tabIndex={-1}
      >
        <div className="upload-modal-head">
          <div>
            <div className="page-title" style={{ fontSize: 18 }}>
              上传伴奏
            </div>
            <p className="page-sub" style={{ marginTop: 2 }}>
              选一个音频文件，想一起跟唱的话再带上歌词。单个文件最大 1GB。
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {draft.note && <div className="alert alert-warn">{draft.note}</div>}

        <Picker
          label="音频文件（必填）"
          hint={multiAudio ? `已选 ${audioFiles.length} 个` : '可一次选多个'}
          accept={AUDIO_ACCEPT}
          multiple
          emptyText="点这里选择音频文件，或把文件拖到伴奏库上传区"
          onPick={pickAudio}
        >
          {audioFiles.length > 0 && (
            <div className="upload-file-list">
              {audioFiles.map((file, index) => (
                <div key={`${file.name}-${index}`} className="upload-file-row">
                  <span className="upload-file-name" title={file.name}>
                    🎵 {file.name}
                  </span>
                  <span className="faint small mono">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeAudio(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Picker>

        <Picker
          label="歌词文件（可选）"
          hint=".lrc / .txt"
          accept={LYRICS_ACCEPT}
          disabled={multiAudio}
          emptyText={
            multiAudio ? '一次传多个音频时不能同时指定歌词，可上传后在编辑里补' : '点这里选择歌词文件'
          }
          onPick={pickLyrics}
        >
          {lyricsFile && (
            <div className="upload-file-list">
              <div className="upload-file-row">
                <span className="upload-file-name" title={lyricsFile.name}>
                  📄 {lyricsFile.name}
                </span>
                <span className="faint small mono">{formatBytes(lyricsFile.size)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setLyricsFile(null)}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </Picker>

        <div className="small faint">
          歌词每行都要带时间戳（例如 <code>[00:12.00]第一句</code>）；不上传歌词的话，
          演唱时就没有跟唱字幕，之后也可以在伴奏库里点「编辑」补。
          {lyricsFile && audioFiles.length === 1 && '歌词会跟着第一个音频一起入库。'}
        </div>

        {info && <div className="small" style={{ color: 'var(--accent-2)', marginTop: 10 }}>{info}</div>}

        {error && (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 10 }}>
            {error}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => void onSubmit(audioFiles, lyricsFile)}
          >
            开始上传
          </button>
        </div>
      </div>
    </div>
  );
}

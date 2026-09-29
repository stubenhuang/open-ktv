import { useEffect, useMemo, useRef, useState } from 'react';
import { findActiveLineIndex, lrcDisplayTimeMs, lyricClockMs, parseLrc } from '../../../shared/lrc';
import { LYRIC_LINE_HEIGHT, LYRIC_VIEW_LINES, lyricTrackOffsetY } from '../utils';

interface Props {
  /** 规范化后的 LRC 文本；null / 空串 / 纯文本都表示「没有可跟唱的歌词」 */
  lyrics: string | null;
  /** 歌词全局微调（ms）：正值 = 歌词更晚显示 */
  lyricsOffsetMs: number;
  /** 时间源。null = 媒体还没挂上 */
  mediaEl: HTMLMediaElement | null;
  /** 录音中禁止点行 seek —— 拖动时间轴会直接破坏自动对齐 */
  canSeek: boolean;
  /** 视频伴奏时叠在画面上（半透明底 + 渐变遮罩），否则铺满整个舞台 */
  overlay?: boolean;
}

/**
 * 跟唱歌词。
 *
 * 设计要点：
 *  - 时钟自己拉（requestAnimationFrame 读 mediaEl.currentTime），不走 SingPage 的
 *    state —— 否则整个演唱页每秒要重渲染 30 次。行为对齐 LevelMeter 的写法。
 *  - 只在「当前行变了」时 setState，正常播放一秒最多变几次。
 *  - 不用 media 的 timeupdate：它只有约 4Hz，歌词会一顿一顿地跳。
 *  - 滚动用 transform: translateY + CSS transition，不做平滑滚动的 JS 补间。
 */
export function LyricsView({ lyrics, lyricsOffsetMs, mediaEl, canSeek, overlay = false }: Props) {
  const doc = useMemo(() => parseLrc(lyrics ?? ''), [lyrics]);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 上一次的高亮行；用它挡住多余的 setState（state 本身在闭包里读不到最新值） */
  const activeRef = useRef(-1);

  // 换歌 / 换歌词文本：高亮重置到「还没进第一句」
  useEffect(() => {
    activeRef.current = -1;
    setActiveIndex(-1);
  }, [doc]);

  useEffect(() => {
    if (!mediaEl || doc.lines.length === 0) return;

    let frame = 0;
    const tick = () => {
      const clock = lyricClockMs(mediaEl.currentTime * 1000, doc.offsetMs, lyricsOffsetMs);
      const index = findActiveLineIndex(doc.lines, clock);
      if (index !== activeRef.current) {
        activeRef.current = index;
        setActiveIndex(index);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mediaEl, doc, lyricsOffsetMs]);

  if (doc.lines.length === 0) return null;

  // 还没进第一句时按第 0 行定位（不然后面几十行会被推到屏幕外）
  const offsetY = lyricTrackOffsetY(activeIndex);

  const seekTo = (lineIndex: number) => {
    if (!mediaEl || !canSeek) return;
    const line = doc.lines[lineIndex];
    if (!line) return;
    // 用与服务端/滚动同一套公式换算回音频时间，seek 之后这一行才会正好高亮
    const targetMs = lrcDisplayTimeMs(line.timeMs, doc.offsetMs, lyricsOffsetMs);
    mediaEl.currentTime = Math.max(0, targetMs / 1000);
  };

  return (
    <div
      className={`lyrics-view${overlay ? ' lyrics-view-overlay' : ''}`}
      style={{ height: LYRIC_VIEW_LINES * LYRIC_LINE_HEIGHT }}
    >
      <div className="lyrics-track" style={{ transform: `translateY(${offsetY}px)` }}>
        {doc.lines.map((line, index) => {
          const state = index === activeIndex ? 'active' : index < activeIndex ? 'past' : 'future';
          return (
            <div
              key={`${line.timeMs}-${index}`}
              className={`lyric-line lyric-${state}${canSeek ? ' lyric-seekable' : ''}`}
              style={{ height: LYRIC_LINE_HEIGHT, lineHeight: `${LYRIC_LINE_HEIGHT}px` }}
              onClick={() => seekTo(index)}
              title={canSeek ? '点这一行跳到对应位置' : '录音中不能跳转'}
            >
              {/* 间奏行（时间戳 + 空文本）渲染成占位符，否则会是一片突兀的空白 */}
              {line.text || <span className="lyric-gap">· · ·</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findActiveLineIndex,
  lrcDisplayTimeMs,
  lyricCharLitCount,
  lyricClockMs,
  lyricLineProgress,
  lyricLineWindowMs,
  parseLrc,
} from '../../../shared/lrc';
import {
  LYRIC_FULLSCREEN_LINE_HEIGHT,
  LYRIC_FULLSCREEN_VIEW_LINES,
  LYRIC_LINE_HEIGHT,
  LYRIC_VIEW_LINES,
  lyricLineSizeClass,
  lyricTrackOffsetY,
} from '../utils';

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
  /** 录音中的全屏模式：更大的字号与行高（行高走 lyricTrackOffsetY 的同一套公式） */
  fullscreen?: boolean;
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
 *  - 逐字填充同样在同一个 rAF 里做：按「行时长均分到每个字」算出点亮字数，
 *    直接改 span 的 class（不进 React state，不触发重渲染）。
 */
export function LyricsView({ lyrics, lyricsOffsetMs, mediaEl, canSeek, overlay = false, fullscreen = false }: Props) {
  const doc = useMemo(() => parseLrc(lyrics ?? ''), [lyrics]);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 上一次的高亮行；用它挡住多余的 setState（state 本身在闭包里读不到最新值） */
  const activeRef = useRef(-1);
  /** 每一行的 DOM 节点（按下标存），用来在行切换后抓当前行的字符 span */
  const lineEls = useRef<(HTMLDivElement | null)[]>([]);
  /** 当前行的字符 span 缓存；rAF 每帧只碰这几个节点 */
  const charRefs = useRef<HTMLSpanElement[]>([]);
  /** 上一帧已点亮的字数；没变就不写 DOM */
  const litRef = useRef(-1);

  const lineHeight = fullscreen ? LYRIC_FULLSCREEN_LINE_HEIGHT : LYRIC_LINE_HEIGHT;
  const visibleLines = fullscreen ? LYRIC_FULLSCREEN_VIEW_LINES : LYRIC_VIEW_LINES;

  // 换歌 / 换歌词文本：高亮重置到「还没进第一句」
  useEffect(() => {
    activeRef.current = -1;
    setActiveIndex(-1);
    lineEls.current = [];
    charRefs.current = [];
    litRef.current = -1;
  }, [doc]);

  /**
   * 逐字填充：把当前行的前 litCount 个字点亮。
   *
   * 字级时刻是推出来的 —— LRC 只有行级时间戳，所以按「本行到下一行的时长 ÷ 字符数」
   * 均分（lyricLineWindowMs / lyricLineProgress，纯函数有单测）。
   * 只在点亮字数变化时写 DOM：一行十几个字，逐字翻亮一秒最多动十几次。
   */
  const paintFill = useCallback(
    (audioMs: number) => {
      const chars = charRefs.current;
      const index = activeRef.current;
      if (index < 0 || chars.length === 0) return;
      const line = doc.lines[index];
      if (!line) return;
      // 末行借媒体时长；duration 是 NaN（流式/未加载）时按 0 传，让工具函数走兜底
      const durationMs = mediaEl && Number.isFinite(mediaEl.duration) ? mediaEl.duration * 1000 : 0;
      const { startMs, endMs } = lyricLineWindowMs(
        doc.lines,
        index,
        doc.offsetMs,
        lyricsOffsetMs,
        durationMs,
      );
      const lit = lyricCharLitCount(lyricLineProgress(audioMs, startMs, endMs), chars.length);
      if (lit === litRef.current) return;
      litRef.current = lit;
      for (let i = 0; i < chars.length; i += 1) {
        chars[i]!.classList.toggle('is-lit', i < lit);
      }
    },
    [doc, lyricsOffsetMs, mediaEl],
  );

  // 当前行换了（或对轴变了）：span 是新建的，重新抓一份缓存并立刻补一帧填充
  useEffect(() => {
    const node = lineEls.current[activeIndex] ?? null;
    charRefs.current = node ? Array.from(node.querySelectorAll<HTMLSpanElement>('.lyric-char')) : [];
    litRef.current = -1;
    if (mediaEl && charRefs.current.length > 0) {
      paintFill(mediaEl.currentTime * 1000);
    }
  }, [activeIndex, doc, lyricsOffsetMs, mediaEl, paintFill]);

  useEffect(() => {
    if (!mediaEl || doc.lines.length === 0) return;

    let frame = 0;
    const tick = () => {
      const audioMs = mediaEl.currentTime * 1000;
      const clock = lyricClockMs(audioMs, doc.offsetMs, lyricsOffsetMs);
      const index = findActiveLineIndex(doc.lines, clock);
      if (index !== activeRef.current) {
        activeRef.current = index;
        setActiveIndex(index);
      }
      paintFill(audioMs);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mediaEl, doc, lyricsOffsetMs, paintFill]);

  if (doc.lines.length === 0) return null;

  // 还没进第一句时按第 0 行定位（不然后面几十行会被推到屏幕外）
  const offsetY = lyricTrackOffsetY(activeIndex, lineHeight, visibleLines);

  /**
   * 「下一句」：比普通行大一号，比当前行小一号 —— 抬头就能看到马上要唱什么。
   * activeIndex 为 −1（还没开口）时下一句就是第 0 行；唱到最后一句时没有下一句。
   */
  const nextIndex = activeIndex >= 0 ? activeIndex + 1 : 0;

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
      className={`lyrics-view${overlay ? ' lyrics-view-overlay' : ''}${fullscreen ? ' lyrics-view-fullscreen' : ''}`}
      style={{ height: visibleLines * lineHeight }}
    >
      <div className="lyrics-track" style={{ transform: `translateY(${offsetY}px)` }}>
        {doc.lines.map((line, index) => {
          const state =
            index === activeIndex ? 'active' : index === nextIndex ? 'next' : index < activeIndex ? 'past' : 'future';
          // 只有当前行拆字（唱到哪个字亮哪个字）；其余行保持纯文本，
          // 这样 DOM 里同时只有一行的 span，ellipsis 等原有样式也不受影响
          const chars = index === activeIndex && line.text ? Array.from(line.text) : null;
          const sizeClass = fullscreen ? ` ${lyricLineSizeClass(line.text)}` : '';
          return (
            <div
              key={`${line.timeMs}-${index}`}
              ref={(node) => {
                lineEls.current[index] = node;
              }}
              className={`lyric-line lyric-${state}${canSeek ? ' lyric-seekable' : ''}${sizeClass}`}
              style={{ height: lineHeight, lineHeight: `${lineHeight}px` }}
              onClick={() => seekTo(index)}
              title={canSeek ? '点这一行跳到对应位置' : '录音中不能跳转'}
            >
              {chars ? (
                chars.map((char, charIndex) => (
                  <span key={charIndex} className="lyric-char">
                    {char}
                  </span>
                ))
              ) : // 间奏行（时间戳 + 空文本）渲染成占位符，否则会是一片突兀的空白
              line.text || <span className="lyric-gap">· · ·</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

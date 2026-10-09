import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../utils';

/**
 * 主题统一的小播放器：播放/暂停 + 进度条 + 时间。
 *
 * 为什么替换原生 <audio controls>：原生控件是浅色圆角条，贴在深色 UI 上像
 * 一块补丁；作品库一屏八张卡就是八条补丁。行为保持不变 —— 内部仍是真实
 * <audio>（只是不带 controls），播放/ seek / 结束语义与原来一致。
 *
 * 实现要点（与 LivePreview / LevelMeter 同一套思路）：
 *  - 播放位置用 rAF **直写 DOM**（range 的 value + 时间文本），不进 React
 *    state —— 每秒 60 次重渲染在这里毫无必要；
 *  - 拖动过程中只更新 UI，松手（或停手 120ms）才一次性 seek，避免每个像素
 *    都去挪 currentTime；
 *  - 模块级单例：同一时刻只有一个播放器在响，播新的自动暂停旧的。
 */
interface Props {
  src: string;
  /** 挂载后立即播放（伴奏库点「试听」时用；此时用户手势刚发生，自动播放策略放行） */
  autoPlay?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  onEnded?: () => void;
}

/** 正在播放的元素：模块级，跨组件实例共享 */
let currentAudio: HTMLAudioElement | null = null;

export function AudioPlayer({ src, autoPlay = false, preload = 'metadata', onEnded }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  /** 拖动中：暂停 rAF 的位置刷新，避免和用户输入打架 */
  const draggingRef = useRef(false);
  const seekTimerRef = useRef<number | null>(null);
  /** onEnded 用 ref 拿最新回调：effect 不必因为它重挂 */
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  // 播放中：rAF 直写进度与时间（不触发重渲染）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playing) return;
    let frame = 0;
    const tick = () => {
      if (!draggingRef.current) {
        const position = audio.currentTime;
        if (rangeRef.current) rangeRef.current.value = String(position);
        if (currentRef.current) currentRef.current.textContent = formatDuration(position);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // 元数据到位：把总时长写进步长与读数（只做一次，之后不再重渲染）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const syncDuration = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (rangeRef.current) rangeRef.current.max = String(duration);
      if (totalRef.current) totalRef.current.textContent = formatDuration(duration);
    };
    audio.addEventListener('loadedmetadata', syncDuration);
    audio.addEventListener('durationchange', syncDuration);
    // preload="metadata" 也可能在 effect 挂上时就好了
    if (audio.readyState >= 1) syncDuration();
    return () => {
      audio.removeEventListener('loadedmetadata', syncDuration);
      audio.removeEventListener('durationchange', syncDuration);
    };
  }, []);

  // 卸载：丢掉没提交的 seek 定时器；若自己是当前响着的那个，让出单例
  useEffect(
    () => () => {
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
      if (currentAudio === audioRef.current) currentAudio = null;
    },
    [],
  );

  const writePosition = (position: number) => {
    if (rangeRef.current) rangeRef.current.value = String(position);
    if (currentRef.current) currentRef.current.textContent = formatDuration(position);
  };

  /**
   * 认领单例：暂停别的播放器，把自己记成当前响着的。
   * handleToggle 和 onPlay 都走它 —— onPlay 覆盖 autoPlay 那条路
   * （挂载即播没经过点击，不认领的话两个播放器会同时响）。
   * pause() 的事件是同步派发的，对方 onPause 里会把单例清掉，所以顺序是
   * 「先暂停旧的，再写上自己」。
   */
  const claim = (audio: HTMLAudioElement) => {
    if (currentAudio && currentAudio !== audio) currentAudio.pause();
    currentAudio = audio;
  };

  const commitSeek = () => {
    if (seekTimerRef.current !== null) {
      window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    draggingRef.current = false;
    const audio = audioRef.current;
    const target = Number(rangeRef.current?.value ?? '0');
    if (audio && Number.isFinite(target)) {
      audio.currentTime = target;
      writePosition(target);
    }
  };

  const handleToggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      claim(audio);
      // play() 在浏览器拦截时 reject：必须接住，否则未处理的 rejection
      // 会进 console.error —— e2e 的「控制台零报错」门禁直接判失败
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
      if (currentAudio === audio) currentAudio = null;
    }
  };

  return (
    <div className="audio-player">
      <button
        type="button"
        className={`audio-player-btn${playing ? ' playing' : ''}`}
        aria-label={playing ? '暂停' : '播放'}
        onClick={handleToggle}
      >
        <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
      </button>
      <input
        ref={rangeRef}
        className="audio-player-track"
        type="range"
        min={0}
        max={0}
        step={0.1}
        defaultValue={0}
        aria-label="播放进度"
        onChange={(event) => {
          // 输入中：只让 UI 跟手，引擎那侧攒着，停手后合并成一次 seek
          draggingRef.current = true;
          writePosition(Number(event.target.value));
          if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
          seekTimerRef.current = window.setTimeout(commitSeek, 120);
        }}
        onPointerUp={commitSeek}
        onPointerCancel={commitSeek}
        onKeyUp={commitSeek}
        onBlur={commitSeek}
      />
      <span className="audio-player-time">
        <span ref={currentRef}>{formatDuration(0)}</span>
        {' / '}
        <span ref={totalRef}>{formatDuration(0)}</span>
      </span>
      <audio
        ref={audioRef}
        src={src}
        preload={preload}
        autoPlay={autoPlay}
        onPlay={(event) => {
          claim(event.currentTarget);
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
          if (currentAudio === audioRef.current) currentAudio = null;
        }}
        onEnded={() => {
          setPlaying(false);
          if (currentAudio === audioRef.current) currentAudio = null;
          writePosition(0);
          endedRef.current?.();
        }}
      />
    </div>
  );
}

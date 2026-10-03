import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewEngine } from '../audio/preview';
import { log } from '../log';
import { formatDuration } from '../utils';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  engine: PreviewEngine | null;
  status: PreviewStatus;
  error: string | null;
  /** 引擎尚未创建时点播放：由父组件懒加载创建，返回建好并起播的引擎（失败返回 null） */
  onRequestPlay: () => Promise<PreviewEngine | null>;
}

/** 播放中位置刷新间隔；200ms 足够顺眼，又不至于频繁重渲染 */
const TICK_MS = 200;
/**
 * 拖进度条时 seek 的合并窗。
 *
 * 拖动过程中每个像素都发一次 input：每次都 seek 就是每次都停/起两轨，
 * 听到的是一路爆音。这里只让 UI 位置跟手，真正 seek 等停手后合成一次
 * （和预览引擎里对齐重排的 OFFSET_REARM_MS 同一个思路）。
 */
const SEEK_COMMIT_MS = 120;

/**
 * 「实时试听」卡片：播放/暂停 + 进度条。
 *
 * 它只负责 transport UI；参数改动的实时生效由父组件把 MixPanel 的
 * onParamsChange 接到 PreviewEngine.setParams 上完成。
 */
export function LivePreview({ engine, status, error, onRequestPlay }: Props) {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const draggingRef = useRef(false);
  /** 拖动中记下的待 seek 位置；尚未提交给引擎 */
  const pendingSeekRef = useRef<number | null>(null);
  const seekTimerRef = useRef<number | null>(null);

  // 换了一首作品（engine 实例变化）时同步到引擎的真实状态。
  // 注意不能无条件 setPlaying(false)：懒加载路径里引擎建好时已经在播了，
  // 这个 effect 的 flush 可能排在「起播回调」之后，盲目置 false 会把按钮盖回去。
  useEffect(() => {
    setPlaying(engine?.playing ?? false);
    setPosition(engine?.positionSec ?? 0);
    setDuration(engine?.durationSec ?? 0);
    if (!engine) return;
    engine.onEnded = () => {
      setPlaying(false);
      setPosition(engine.durationSec);
    };
    return () => {
      engine.onEnded = null;
    };
  }, [engine]);

  // 播放中定时读位置；拖动进度条时暂停刷新，避免和用户输入打架
  useEffect(() => {
    if (!engine || !playing) return;
    const timer = window.setInterval(() => {
      if (draggingRef.current) return;
      setPosition(engine.positionSec);
      setDuration(engine.durationSec);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [engine, playing]);

  // 卸载时丢掉还没提交的 seek 定时器
  useEffect(
    () => () => {
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    },
    [],
  );

  /** 把拖动期间积攒的目标位置一次性交给引擎 */
  const flushSeek = useCallback(() => {
    if (seekTimerRef.current !== null) {
      window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    draggingRef.current = false;
    const target = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (target !== null) engine?.seek(target);
  }, [engine]);

  /** 松手（或停手）：立刻提交，不等合并窗剩下的时间 */
  const releaseSeek = useCallback(() => {
    if (pendingSeekRef.current === null) {
      draggingRef.current = false;
      return;
    }
    flushSeek();
  }, [flushSeek]);

  const handleToggle = () => {
    if (!engine) {
      // 懒加载：等父组件建好引擎并起播，再把按钮/进度同步到真实状态
      void onRequestPlay().then((created) => {
        if (!created) return;
        setPlaying(created.playing);
        setPosition(created.positionSec);
        setDuration(created.durationSec);
      });
      return;
    }
    void engine.toggle().then(
      () => {
        setPlaying(engine.playing);
        setPosition(engine.positionSec);
        setDuration(engine.durationSec);
      },
      (err: unknown) => {
        setPlaying(false);
        // play() 只在浏览器拦截等极端情况失败，直接把原因抛给控制台排障
        log.error('preview', '播放失败', err);
      },
    );
  };

  const handleSeek = (value: number) => {
    // 输入中：只更新 UI，引擎那侧攒着，停手后合并成一次 seek
    setPosition(value);
    pendingSeekRef.current = value;
    draggingRef.current = true;
    if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current);
    seekTimerRef.current = window.setTimeout(() => flushSeek(), SEEK_COMMIT_MS);
  };

  const disabled = status === 'loading';

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <strong>实时试听</strong>
        <span className="badge badge-accent">改动立即生效</span>
      </div>

      <div className="preview-transport">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={handleToggle}
        >
          {status === 'loading' ? (
            <>
              <span className="spin" style={{ borderTopColor: '#fff' }} />
              加载中…
            </>
          ) : playing ? (
            '⏸ 暂停'
          ) : (
            '▶ 试听'
          )}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(position, Math.max(duration, 0.1))}
          disabled={!engine}
          onChange={(event) => {
            handleSeek(Number(event.target.value));
          }}
          onPointerUp={releaseSeek}
          onPointerCancel={releaseSeek}
          onKeyUp={releaseSeek}
          onBlur={releaseSeek}
        />
        <span className="preview-time">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>
      </div>

      {error ? (
        <div className="small" style={{ marginTop: 10, color: 'var(--danger)' }}>
          预览失败：{error}（可以回作品库听已生成的 MP3，或再点一次「试听」重试）
        </div>
      ) : (
        <div className="small faint" style={{ marginTop: 10 }}>
          干声 + 伴奏在浏览器里实时混音：拖滑块、输入毫秒数、换混响都会立刻生效，不打断播放。
          这只是预览 —— 点下面的「合成」服务端才会真正出新版 MP3，然后自动返回作品库。
        </div>
      )}
    </div>
  );
}

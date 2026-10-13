import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibrarySourceStatus,
  type LibraryTaskDto,
} from '../../api';
import { errorMessage, formatBytes, formatDuration } from '../../utils';

/** 任务轮询间隔（与桌面点歌台一致） */
const TASK_POLL_MS = 700;

type KindFilter = 'all' | LibraryItemKind;

/** 条目在结果里的唯一键，与后端 library_ref 同构 */
function itemKey(item: LibraryItemDto): string {
  return `${item.providerId}:${item.itemId}`;
}

/**
 * 手机端点歌台。
 *
 * 和桌面点歌台是同一套链路（搜索 → 点歌 → 服务端下载入库 → 去演唱），
 * 只是排版换成移动端：搜索框独占一行、分类 chip 横滑、结果行紧凑。
 * 同样**不做边打边搜** —— 每个字符都打一次接口既刷爆服务端，结果也噼里啪啦地闪。
 */
export default function MobileDiscoverPage() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [items, setItems] = useState<LibraryItemDto[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<LibrarySourceStatus[]>([]);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  /** 每个条目当前排着的任务状态（按 itemKey 索引，便于在卡片上就地显示） */
  const [tasksByItem, setTasksByItem] = useState<Record<string, LibraryTaskDto>>({});
  /** 已在库里的条目（重复点歌时后端直接告知） */
  const [imported, setImported] = useState<Record<string, string>>({});

  /* ------------------------------- 源是否配了 ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    api
      .listLibrarySources()
      .then((result) => {
        if (!cancelled) setSourceCount(result.sources.length);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, '读取曲库源失败'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* --------------------------------- 搜索 --------------------------------- */

  const runSearch = useCallback(async (text: string, kindFilter: KindFilter) => {
    setSearching(true);
    try {
      const result = await api.searchLibrary(text, kindFilter === 'all' ? null : kindFilter);
      setItems(result.items);
      setSourceStatuses(result.sources);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, '搜索失败'));
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }, []);

  // 首次进来就把曲库列出来（空关键词 = 全部），不用先打字
  const initialSearchDone = useRef(false);
  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;
    void runSearch('', 'all');
  }, [runSearch]);

  const submitSearch = useCallback(() => {
    void runSearch(query, kind);
  }, [query, kind, runSearch]);

  /* ------------------------------ 任务轮询 ------------------------------ */

  const pendingTasks = useMemo(
    () =>
      Object.entries(tasksByItem)
        .filter(([, task]) => task.state === 'queued' || task.state === 'running')
        .map(([key, task]) => ({ key, taskId: task.taskId })),
    [tasksByItem],
  );
  const pendingKey = useMemo(() => JSON.stringify(pendingTasks), [pendingTasks]);

  useEffect(() => {
    if (!pendingKey) return;
    const entries = JSON.parse(pendingKey) as { key: string; taskId: string }[];
    let cancelled = false;

    const timer = window.setInterval(() => {
      for (const { key, taskId } of entries) {
        void api
          .getLibraryTask(taskId)
          .then((task) => {
            if (cancelled) return;
            setTasksByItem((previous) => ({ ...previous, [key]: task }));
            if (task.state === 'done' && task.trackId) {
              const trackId = task.trackId;
              setImported((previous) => ({ ...previous, [key]: trackId }));
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            // 任务表在服务端进程里，重启后会 404 —— 明确标失败并让用户重试
            setTasksByItem((previous) => {
              const current = previous[key];
              if (!current) return previous;
              return { ...previous, [key]: { ...current, state: 'failed', error: errorMessage(err) } };
            });
          });
      }
    }, TASK_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingKey]);

  /* --------------------------------- 点歌 --------------------------------- */

  const handleDownload = async (item: LibraryItemDto) => {
    const key = itemKey(item);
    setError(null);
    try {
      const result = await api.downloadFromLibrary(item.providerId, item.itemId);
      if ('alreadyImported' in result) {
        setImported((previous) => ({ ...previous, [key]: result.track.id }));
        return;
      }
      setTasksByItem((previous) => ({
        ...previous,
        [key]: {
          taskId: result.taskId,
          title: result.title,
          state: 'queued',
          progress: 0,
          trackId: null,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }));
    } catch (err) {
      setError(errorMessage(err, '点歌失败'));
    }
  };

  /* --------------------------------- 渲染 --------------------------------- */

  // 一个源都没配：给配置指引，而不是一个空页面
  if (sourceCount === 0) {
    return (
      <div className="m-page">
        <header className="m-head">
          <div>
            <h1 className="m-title">🔍 点歌台</h1>
            <p className="m-sub">搜歌名或歌手，点「点歌」自动下载进伴奏库；有歌词会一起带上。</p>
          </div>
        </header>
        <div className="m-alert m-alert-warn">
          还没有配置任何曲库源。内置 5sing 伴奏源默认是开的（被 FIVESING_ENABLED=0 关掉了？），
          也可以用 LIBRARY_SOURCES 配上自己的源。伴奏照样能手动上传，不受影响。
        </div>
      </div>
    );
  }

  return (
    <div className="m-page">
      <header className="m-head">
        <div>
          <h1 className="m-title">🔍 点歌台</h1>
          <p className="m-sub">搜歌名或歌手，点「点歌」自动下载进伴奏库。</p>
        </div>
      </header>

      {error && (
        <div className="m-alert m-alert-error">
          {error}
          <button type="button" className="m-btn m-btn-ghost m-btn-sm" onClick={submitSearch}>
            重试
          </button>
        </div>
      )}

      <div className="m-search-bar">
        <input
          className="m-input"
          type="search"
          value={query}
          placeholder="歌名 / 歌手"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitSearch();
          }}
        />
        <button
          type="button"
          className="m-btn m-btn-primary m-btn-search"
          disabled={searching}
          onClick={submitSearch}
        >
          {searching ? '搜索中…' : '搜索'}
        </button>
      </div>

      {/* 分类 chip：横滑，窄屏不换行 */}
      <div className="m-chip-row">
        {(
          [
            ['all', '全部'],
            ['audio', '音频'],
            ['video', '视频'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`m-chip${kind === value ? ' active' : ''}`}
            onClick={() => {
              setKind(value);
              void runSearch(query, value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 逐源状态：某源挂了只提示该源，其他源的结果照常显示 */}
      {sourceStatuses.length > 0 && (
        <div className="m-chip-row">
          {sourceStatuses.map((source) => (
            <span key={source.id} className={`m-badge${source.ok ? '' : ' m-badge-warn'}`}>
              {source.ok ? `${source.label} ${source.count}` : `${source.label} 不可用`}
            </span>
          ))}
        </div>
      )}

      {searching && <div className="m-empty">正在搜索…</div>}

      {!searching && searched && items.length === 0 && (
        <div className="m-empty">{query ? `没搜到「${query}」相关的伴奏。` : '曲库里还没有伴奏。'}</div>
      )}

      <ul className="m-track-list">
        {items.map((item) => {
          const key = itemKey(item);
          const task = tasksByItem[key];
          const importedTrackId = imported[key];
          const running = task?.state === 'queued' || task?.state === 'running';

          return (
            <li key={key}>
              <div className="m-track">
                <span className="m-track-icon" aria-hidden="true">
                  {item.kind === 'video' ? '🎬' : '🎵'}
                </span>
                <span className="m-track-main">
                  <span className="m-track-title">{item.title}</span>
                  <span className="m-track-meta">
                    {item.artist ? `${item.artist} · ` : ''}
                    {item.durationSec !== null ? formatDuration(item.durationSec) : '--:--'}
                    {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes)}` : ''}
                    {item.hasLyrics ? ' · 带歌词' : ''}
                  </span>
                  {task?.state === 'failed' && (
                    <span className="m-track-error">{task.error ?? '下载失败'}</span>
                  )}
                </span>
                {running ? (
                  <span className="m-track-go m-track-progress">
                    {Math.round((task?.progress ?? 0) * 100)}%
                    <br />
                    <span className="m-faint">{task?.state === 'queued' ? '排队中' : '下载中'}</span>
                  </span>
                ) : importedTrackId || task?.trackId ? (
                  <Link className="m-btn m-btn-primary m-btn-sm" to={`/m/sing/${importedTrackId ?? task?.trackId}`}>
                    去演唱
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="m-btn m-btn-primary m-btn-sm"
                    onClick={() => void handleDownload(item)}
                  >
                    {task?.state === 'failed' ? '重试' : '点歌'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

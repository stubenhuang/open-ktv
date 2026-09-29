import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibrarySourceStatus,
  type LibraryTaskDto,
} from '../api';
import { errorMessage, formatBytes, formatDuration } from '../utils';

/** 搜索防抖：敲字过程中不该每个字符都打一次接口 */
const SEARCH_DEBOUNCE_MS = 300;
/** 任务轮询间隔 */
const TASK_POLL_MS = 700;

type KindFilter = 'all' | LibraryItemKind;

/** 条目在结果里的唯一键，与后端 library_ref 同构 */
function itemKey(item: LibraryItemDto): string {
  return `${item.providerId}:${item.itemId}`;
}

/**
 * 点歌台。
 *
 * 搜索 → 点歌（服务端下载并入库）→ 去演唱。真正的下载/入库/转码在服务端
 * 单并发队列里跑，这里只负责排任务 + 轮询进度。
 */
export default function DiscoverPage() {
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

  // 首次进来就把曲库列出来（空关键词 = 全部），不用先打字。
  // 只跑一次：query/kind 的变化由下面那个防抖 effect 负责。
  const initialSearchDone = useRef(false);
  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;
    void runSearch('', 'all');
  }, [runSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runSearch(query, kind);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, kind, runSearch]);

  /* ------------------------------ 任务轮询 ------------------------------ */

  /**
   * 还在跑的任务，连「属于哪个条目」一起带上。
   * 这样轮询回包时按 key 直接写回，不需要靠 taskId 反查 —— 反查就要读
   * tasksByItem，那是过期闭包，任务一多必然串味。
   */
  const pendingTasks = useMemo(
    () =>
      Object.entries(tasksByItem)
        .filter(([, task]) => task.state === 'queued' || task.state === 'running')
        .map(([key, task]) => ({ key, taskId: task.taskId }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    [tasksByItem],
  );
  /** 用 JSON 当依赖键：比手拼分隔符安全（itemId 是 URL，什么字符都可能有） */
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
              return {
                ...previous,
                [key]: { ...current, state: 'failed', error: errorMessage(err) },
              };
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

  // 还没配任何源：给配置指引，而不是一个空页面
  if (sourceCount === 0) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">点歌台</h1>
            <p className="page-sub">搜索曲库 → 点歌（自动下载并入库）→ 去演唱。</p>
          </div>
        </div>
        <div className="card">
          <div className="page-title" style={{ fontSize: 16 }}>
            还没有配置任何曲库源
          </div>
          <p className="page-sub" style={{ marginTop: 6 }}>
            本项目的曲库源是「你提供的清单地址」，启动时通过 <code>LIBRARY_SOURCES</code>{' '}
            环境变量配置。源站只需要托管一份静态 JSON，不需要任何服务端逻辑，
            所以 NAS、对象存储、局域网 HTTP 都能直接用。
          </p>
          <pre className="library-config-sample">{`LIBRARY_SOURCES="我的伴奏库=https://nas.local/ktv/index.json" ./openktv.sh start`}</pre>
          <p className="small faint" style={{ marginTop: 8 }}>
            清单格式：{`{"version":1,"name":"我的伴奏库","items":[{"id":"qingtian","title":"晴天","artist":"周杰伦","kind":"audio","url":"qingtian.mp3","lrc":"qingtian.lrc"}]}`}
            <br />
            配好之后重启服务即可。伴奏照样能手动上传，不受影响。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">点歌台</h1>
          <p className="page-sub">
            搜索曲库 → 点歌（服务端自动下载并入库）→ 去演唱。清单里带了歌词的会一并入库。
          </p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void runSearch(query, kind)}
          >
            重试
          </button>
        </div>
      )}

      <div className="card library-search-bar">
        <input
          className="text-input"
          style={{ flex: '1 1 240px' }}
          value={query}
          placeholder="搜索歌名或歌手…"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="reverb-options">
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
              className={`reverb-option${kind === value ? ' active' : ''}`}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {searching && <span className="spin" />}
      </div>

      {/* 逐源状态：某源挂了只提示该源，其他源的结果照常显示 */}
      {sourceStatuses.length > 0 && (
        <div className="library-source-row">
          {sourceStatuses.map((source) => (
            <span
              key={source.id}
              className={`badge ${source.ok ? 'badge-kind' : 'badge-fail'}`}
              title={source.error ?? ''}
            >
              {source.ok ? `${source.label}（${source.count}）` : `${source.label}：不可用`}
            </span>
          ))}
        </div>
      )}

      {searched && items.length === 0 && !searching ? (
        <div className="empty-state" style={{ marginTop: 20 }}>
          {query ? `没搜到「${query}」相关的伴奏。` : '曲库里还没有伴奏。'}
        </div>
      ) : (
        <div className="track-list">
          {items.map((item) => {
            const key = itemKey(item);
            const task = tasksByItem[key];
            const importedTrackId = imported[key];
            const running = task?.state === 'queued' || task?.state === 'running';
            const failed = task?.state === 'failed';

            return (
              <div key={key} className="track-item">
                <div className="track-kind" title={item.kind === 'video' ? '视频伴奏' : '音频伴奏'}>
                  {item.kind === 'video' ? '🎬' : '🎵'}
                </div>

                <div className="track-main">
                  <div className="track-title">{item.title}</div>
                  <div className="track-meta">
                    {item.artist && <span>{item.artist}</span>}
                    {item.durationSec !== null && (
                      <span className="mono">{formatDuration(item.durationSec)}</span>
                    )}
                    {item.sizeBytes !== null && <span>{formatBytes(item.sizeBytes)}</span>}
                    {item.hasLyrics && <span className="badge badge-ok">带歌词</span>}
                  </div>
                  {failed && (
                    <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
                      {task?.error ?? '下载失败'}
                    </div>
                  )}
                </div>

                <div className="track-actions">
                  {running ? (
                    <>
                      <div className="progress-track" style={{ width: 110 }}>
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.round((task?.progress ?? 0) * 100)}%` }}
                        />
                      </div>
                      <span className="small muted" style={{ minWidth: 66 }}>
                        {task?.state === 'queued' ? '排队中…' : '下载中…'}
                      </span>
                    </>
                  ) : importedTrackId || task?.trackId ? (
                    <>
                      <span className="badge badge-ok">已入库</span>
                      <Link className="btn btn-primary btn-sm" to={`/sing/${importedTrackId ?? task?.trackId}`}>
                        去演唱
                      </Link>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleDownload(item)}
                    >
                      {failed ? '重试点歌' : '点歌'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type LibraryItemDto,
  type LibraryItemKind,
  type LibrarySourceStatus,
  type LibraryTaskDto,
} from '../api';
import { EmptyState } from '../components/EmptyState';
import { TrackSkeletonList } from '../components/Skeleton';
import { errorMessage, formatBytes, formatDuration } from '../utils';
import { useI18n } from '../i18n';

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
  const { t, fmt, locale } = useI18n();
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
        if (!cancelled) setError(errorMessage(err, t('discover.sources.failed')));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

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
      setError(errorMessage(err, t('discover.search.failed')));
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }, [t]);

  // 首次进来就把曲库列出来（空关键词 = 全部），不用先打字。
  // 只跑一次：之后的搜索全部由「搜索」按钮 / 回车 / 切分类触发。
  const initialSearchDone = useRef(false);
  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;
    void runSearch('', 'all');
  }, [runSearch]);

  /**
   * 点「搜索」或回车：拿当前输入框和分类真的打一次接口。
   *
   * 刻意不做输入防抖/自动搜索 —— 敲歌名时每个字符都打一次接口，
   * 既刷爆服务端，也让结果列表噼里啪啦地闪。分类 chip 的点击同理算明确意图，
   * 切完立刻按新分类重搜（用的还是输入框里的当前关键词）。
   */
  const submitSearch = useCallback(() => {
    void runSearch(query, kind);
  }, [query, kind, runSearch]);

  const handleKindChange = (value: KindFilter) => {
    setKind(value);
    void runSearch(query, value);
  };

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
      setError(errorMessage(err, t('discover.request.failed')));
    }
  };

  /* --------------------------------- 渲染 --------------------------------- */

  // 一个源都没配：给配置指引，而不是一个空页面。
  // 内置 5sing 默认开着，走到这里说明被 FIVESING_ENABLED=0 关掉了。
  if (sourceCount === 0) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('discover.title')}</h1>
            <p className="page-sub">{t('discover.subtitle')}</p>
          </div>
        </div>
        <div className="card">
          <div className="page-title" style={{ fontSize: 16 }}>
            <span aria-hidden="true">📂 </span>
            {t('discover.noSources.title')}
          </div>
          <p className="page-sub" style={{ marginTop: 6 }}>
            {t('discover.noSources.description')}
          </p>
          {/*
            环境变量和 JSON 格式是给「打算自建源」的人看的，大多数人永远不需要 ——
            折进 details，卡片保持三行以内；标题「还没有配置任何曲库源」留在外面，
            页面的主要信息（没源可用 + 怎么办）一眼能读完。
          */}
          <details className="library-config-details">
            <summary>{t('discover.noSources.howTo')}</summary>
            <p className="small faint" style={{ marginTop: 6 }}>
              {t('discover.noSources.builtin')}{' '}
              <code>FIVESING_ENABLED=1</code>
              {t('discover.noSources.builtinAfter')}{' '}
              <code>LIBRARY_SOURCES</code>{' '}
              {t('discover.noSources.custom')}
            </p>
            <pre className="library-config-sample">{t('discover.noSources.sample')}</pre>
            <p className="small faint" style={{ marginTop: 8 }}>
              {t('discover.noSources.format')}
              <br />
              {t('discover.noSources.formatHint')}
            </p>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('discover.title')}</h1>
          <p className="page-sub">{t('discover.subtitle')}</p>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void runSearch(query, kind)}
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="card library-search-bar">
        <div className="search-with-icon">
          <span className="search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            className="text-input"
            value={query}
            placeholder={t('discover.search.placeholder')}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitSearch();
            }}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label={t('discover.search.clear')}
              onClick={() => {
                setQuery('');
                // 清空是明确的意图：直接回到「全部」，省得用户再按一次搜索
                void runSearch('', kind);
              }}
            >
              ✕
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: '0 0 auto' }}
          disabled={searching}
          onClick={submitSearch}
        >
          {t('common.search')}
        </button>
        <div className="option-row">
          {(
            [
              ['all', t('common.all')],
              ['audio', t('discover.filter.audio')],
              ['video', t('discover.filter.video')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`reverb-option${kind === value ? ' active' : ''}`}
              onClick={() => handleKindChange(value)}
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
              {source.ok
                ? t('discover.source.ok', { label: source.label, count: fmt.integer(source.count) })
                : t('discover.source.unavailable', { label: source.label })}
            </span>
          ))}
        </div>
      )}

      {searching ? (
        <TrackSkeletonList />
      ) : searched && items.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={query ? t('discover.empty.noMatch.title', { query }) : t('discover.empty.title')}
          description={t('discover.empty.description')}
          action={
            query ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery('');
                  void runSearch('', kind);
                }}
              >
                {t('discover.search.clear')}
              </button>
            ) : (
              <Link className="btn btn-primary" to="/">
                {t('discover.empty.goLibrary')}
              </Link>
            )
          }
        />
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
                <div
                  className="track-kind"
                  title={t(item.kind === 'video' ? 'discover.kind.video' : 'discover.kind.audio')}
                >
                  {item.kind === 'video' ? '🎬' : '🎵'}
                </div>

                <div className="track-main">
                  <div className="track-title">{item.title}</div>
                  <div className="track-meta">
                    {item.artist && <span>{item.artist}</span>}
                    {item.durationSec !== null && (
                      <span className="mono">{formatDuration(item.durationSec)}</span>
                    )}
                    {item.sizeBytes !== null && <span>{formatBytes(item.sizeBytes, locale)}</span>}
                    {item.hasLyrics && <span className="badge badge-ok">{t('discover.hasLyrics')}</span>}
                  </div>
                  {failed && (
                    <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
                      {task?.error ?? t('discover.download.failed')}
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
                      <span className="small muted download-percent">
                        {fmt.percent(task?.progress ?? 0)}
                      </span>
                      <span className="small muted" style={{ minWidth: 66 }}>
                        {task?.state === 'queued'
                          ? t('discover.download.queued')
                          : t('discover.download.running')}
                      </span>
                    </>
                  ) : importedTrackId || task?.trackId ? (
                    <>
                      <span className="badge badge-ok">{t('discover.imported')}</span>
                      <Link className="btn btn-primary btn-sm" to={`/sing/${importedTrackId ?? task?.trackId}`}>
                        {t('discover.goSing')}
                      </Link>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleDownload(item)}
                    >
                      {failed ? t('discover.download.retry') : t('discover.download.button')}
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

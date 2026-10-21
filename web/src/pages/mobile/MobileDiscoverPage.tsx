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
} from '../../api';
import { useI18n } from '../../i18n';
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
        if (!cancelled) setError(errorMessage(err, t('mobile.discover.load_sources_failed')));
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
      setError(errorMessage(err, t('mobile.discover.search_failed')));
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
      setError(errorMessage(err, t('mobile.discover.download_failed')));
    }
  };

  /* --------------------------------- 渲染 --------------------------------- */

  // 一个源都没配：给配置指引，而不是一个空页面
  if (sourceCount === 0) {
    return (
      <div className="m-page">
        <header className="m-head">
          <div>
            <h1 className="m-title">{t('mobile.discover.title')}</h1>
            <p className="m-sub">{t('mobile.discover.subtitle_full')}</p>
          </div>
        </header>
        <div className="m-alert m-alert-warn">{t('mobile.discover.no_sources')}</div>
      </div>
    );
  }

  return (
    <div className="m-page">
      <header className="m-head">
        <div>
          <h1 className="m-title">{t('mobile.discover.title')}</h1>
          <p className="m-sub">{t('mobile.discover.subtitle')}</p>
        </div>
      </header>

      {error && (
        <div className="m-alert m-alert-error">
          {error}
          <button type="button" className="m-btn m-btn-ghost m-btn-sm" onClick={submitSearch}>
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="m-search-bar">
        <input
          className="m-input"
          type="search"
          value={query}
          placeholder={t('mobile.discover.search_placeholder')}
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
          {searching ? t('mobile.discover.searching') : t('common.search')}
        </button>
      </div>

      {/* 分类 chip：横滑，窄屏不换行 */}
      <div className="m-chip-row">
        {(
          [
            ['all', t('common.all')],
            ['audio', t('mobile.kind.audio')],
            ['video', t('mobile.kind.video')],
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
              {source.ok
                ? t('mobile.discover.source_ok', {
                    label: source.label,
                    count: fmt.integer(source.count),
                  })
                : t('mobile.discover.source_unavailable', { label: source.label })}
            </span>
          ))}
        </div>
      )}

      {searching && <div className="m-empty">{t('mobile.discover.searching_list')}</div>}

      {!searching && searched && items.length === 0 && (
        <div className="m-empty">
          {query ? t('mobile.discover.no_results', { query }) : t('mobile.discover.empty_library')}
        </div>
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
                    {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes, locale)}` : ''}
                    {item.hasLyrics ? t('mobile.track.with_lyrics') : ''}
                  </span>
                  {task?.state === 'failed' && (
                    <span className="m-track-error">
                      {task.error ?? t('mobile.discover.download_failed_short')}
                    </span>
                  )}
                </span>
                {running ? (
                  <span className="m-track-go m-track-progress">
                    {fmt.percent(task?.progress ?? 0)}
                    <br />
                    <span className="m-faint">
                      {task?.state === 'queued' ? t('common.pending') : t('mobile.discover.downloading')}
                    </span>
                  </span>
                ) : importedTrackId || task?.trackId ? (
                  <Link className="m-btn m-btn-primary m-btn-sm" to={`/m/sing/${importedTrackId ?? task?.trackId}`}>
                    {t('mobile.discover.go_sing')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="m-btn m-btn-primary m-btn-sm"
                    onClick={() => void handleDownload(item)}
                  >
                    {task?.state === 'failed' ? t('common.retry') : t('mobile.discover.download')}
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

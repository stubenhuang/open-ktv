//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { presetLabel, pitchLabel, reverbSummary } from '../i18n/labels';
import {
  api,
  workAudioDownloadUrl,
  workAudioUrl,
  workVocalDownloadUrl,
  type WorkListItem,
} from '../api';
import { AudioPlayer } from '../components/AudioPlayer';
import { confirmAction } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { WorkSkeletonGrid } from '../components/Skeleton';
import { toast } from '../components/ToastStack';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';
import {
  coverGradient,
  errorMessage,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  selectVisibleWorks,
  type WorksSortBy,
  type WorkStatusFilter,
} from '../utils';

/**
 * 我的作品（作品库列表页）。
 *
 * 一屏之内要回答三个问题：「我唱过什么」（列表行）、「哪首是哪个」（信息）、
 * 「那首在哪」（搜索 / 排序 / 过滤）。所以：
 *  - 列表用**发丝线分隔的行**（.work-row，和風「帳簿」的语言：细罫线 + 留白），
 *    一行两行字装完「标题 + 状态」和「伴奏 · 歌手 · 时长 · 大小 · 效果 · 时间」；
 *    原来是 330px 的卡片网格，一卡四行堆叠，九部作品要三行卡片才放完；
 *  - 工具栏做纯客户端筛选（作品就自己家几十首，和伴奏库同构，见
 *    utils.ts 的 selectVisibleWorks）；
 *  - 改名、重试合成这类一次性的小操作就地完成，不再跳详情页。
 *
 * 播放态：AudioPlayer 的 onPlayingChange 把当前行 id 喂给 playingId，
 * 那一行加 .is-playing（左缘朱线 + 淡朱底 + 行底进度条）。不用 :has() ——
 * iOS 14.5 的 Safari 不支持，而手机端也要能看这个页面。
 *
 * 与后端/其它页的契约：行根元素保留 data-work-id（合成后跳回来定位用，
 * e2e 也指着它）；轮询只在真有作品在混音时跑（usePolling）。
 */

/**
 * 状态过滤档位（chip 上带各自的数量）。
 *
 * labelKey 是文案键而不是文案本身：渲染时经 t() 取当前语言（模块顶层拿不到
 * context，所以这里只放键名）。
 */
const STATUS_FILTERS: { value: WorkStatusFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'common.all' },
  { value: 'ready', labelKey: 'common.ready' },
  { value: 'mixing', labelKey: 'works.status.mixing' },
  { value: 'failed', labelKey: 'common.failed' },
];

/** 重混 chip 的出现阈值：createdAt 与 updatedAt 差过 1 分钟才算「重新混过」 */
const REMIX_HINT_MS = 60_000;

export default function WorksPage() {
  const { t, fmt, plural, locale } = useI18n();
  const location = useLocation();
  const [works, setWorks] = useState<WorkListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 从详情页点「合成」跳回来时要定位的作品 id */
  const focusWorkId =
    (location.state as { focusWorkId?: string } | null | undefined)?.focusWorkId ?? null;
  const focusedRef = useRef(false);

  /* ------------------------------ 筛选状态 ------------------------------ */

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<WorkStatusFilter>('all');
  const [sortBy, setSortBy] = useState<WorksSortBy>('recent');
  const searchRef = useRef<HTMLInputElement>(null);

  /** 正在内联改名的作品；null = 没有在改的 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** 改名 / 重试这类单卡操作 in-flight */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 正在播放的作品 id（AudioPlayer 的 onPlayingChange 喂）；null = 没在播 */
  const [playingId, setPlayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWorks(await api.listWorks());
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t('works.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 定位到目标作品：滚动到视口中央 + 高亮几秒（合成后跳回来用）
  useEffect(() => {
    if (!focusWorkId || focusedRef.current || loading || works.length === 0) return;
    const card = document.querySelector(`[data-work-id="${focusWorkId}"]`);
    if (!card) return;
    focusedRef.current = true;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('work-row-focus');
    const timer = window.setTimeout(() => card.classList.remove('work-row-focus'), 2600);
    return () => window.clearTimeout(timer);
  }, [focusWorkId, loading, works]);

  // 带着 focusWorkId 回来（详情页点了「合成」）时清掉会藏作品的筛选：
  // 用户此刻筛着「失败」，回来的却是刚就绪的那首，不重置的话定位会静默失败。
  // 排序不影响卡片是否存在，不动它。
  const filtersResetRef = useRef(false);
  useEffect(() => {
    if (!focusWorkId || filtersResetRef.current) return;
    filtersResetRef.current = true;
    setQuery('');
    setStatusFilter('all');
  }, [focusWorkId]);

  // 有没有作品在混音 —— 从**全量**列表算，不被当前筛选影响
  // （用户筛「已就绪」时，正在合成的那几首也要继续轮询）
  const hasMixing = works.some((work) => work.status === 'mixing');
  usePolling(() => void load(), 1500, hasMixing);

  /* ------------------------------ 筛选派生 ------------------------------ */

  const visibleWorks = useMemo(
    // 第三个参数是界面语言：歌名排序跟着它走（中文拼音序 / 英文拉丁序）
    () => selectVisibleWorks(works, { query, status: statusFilter, sortBy }, locale),
    [works, query, statusFilter, sortBy, locale],
  );

  /** 每个状态档各有多少部（chip 上的计数） */
  const statusCounts = useMemo(() => {
    const counts: Record<WorkStatusFilter, number> = { all: works.length, ready: 0, mixing: 0, failed: 0 };
    for (const work of works) counts[work.status] += 1;
    return counts;
  }, [works]);

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setSortBy('recent');
  };

  /* -------------------------------- 操作 -------------------------------- */

  const handleDelete = async (work: WorkListItem) => {
    const confirmed = await confirmAction({
      title: t('works.delete.title'),
      message: t('works.delete.message', { title: work.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      toast.ok(t('works.deleted', { title: work.title }));
      if (renamingId === work.id) setRenamingId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, t('works.deleteFailed')));
    }
  };

  /** 内联改名：Enter 提交、Esc 取消；空值前端先拦一道，服务端再兜底 */
  const commitRename = async (work: WorkListItem) => {
    const title = renameDraft.trim();
    if (!title) {
      toast.error(t('works.rename.empty'));
      return;
    }
    setBusyId(work.id);
    try {
      await api.updateWork(work.id, { title });
      setRenamingId(null);
      toast.ok(t('works.renamed'));
      await load();
    } catch (err) {
      // 失败保持编辑态：用户改完名字再试一次，不用从头点开
      toast.error(errorMessage(err, t('works.renameFailed')));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 合成失败的作品就地重试：用现有参数再排一次混音。
   * 成功后必须 load 一次 —— 状态变 mixing 才会让上面的 hasMixing 成立，
   * 轮询跟着转起来，用户不用手动刷新页面。
   */
  const handleRetry = async (work: WorkListItem) => {
    setBusyId(work.id);
    try {
      await api.remixWork(work.id, work.mixParams);
      await load();
    } catch (err) {
      toast.error(errorMessage(err, t('works.retryFailed')));
    } finally {
      setBusyId(null);
    }
  };

  /* ------------------------------ 「/」聚焦搜索 ------------------------------ */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // 正在输入框 / 文本域里打字时不抢（那时 "/" 就是要输入的字）
      if (
        target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* -------------------------------- 渲染 -------------------------------- */

  const renderRow = (work: WorkListItem) => {
    const renaming = renamingId === work.id;
    // 「重混过」只进 title 提示：元信息行里再并排一个「10-16重混 · 10-16演唱」
    // 是两个重复日期，读起来像排版错误
    const remixHint = work.updatedAt - work.createdAt > REMIX_HINT_MS
      ? ` · ${t('works.remix.hint', { time: formatDateTime(work.updatedAt, locale) })}`
      : '';
    const playing = playingId === work.id;

    return (
      <div
        key={work.id}
        className={[
          'work-row',
          work.status === 'mixing' ? 'is-mixing' : '',
          work.status === 'failed' ? 'is-failed' : '',
          playing ? 'is-playing' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-work-id={work.id}
      >
        {/*
          封条：标题首字（明朝体，落款感）+ 由标题哈希决定的渐变。
          原来这里是一枚通用 🎵 —— 一屏九张卡九个一样的音符，等于没有信息。
          时长不放封条了，元信息行里有，不重复。
        */}
        <div
          className="work-row-cover"
          style={{ background: coverGradient(work.title) }}
          aria-hidden="true"
        >
          <span className="work-row-cover-char">{Array.from(work.title)[0] ?? '♪'}</span>
        </div>

        {/* 播放位：就绪的出播放器；合成中的出 spinner；失败的出感叹号 */}
        {work.status === 'ready' ? (
          <AudioPlayer
            variant="row"
            src={workAudioUrl(work.id, work.updatedAt)}
            preload="none"
            totalDuration={work.vocalDuration}
            onPlayingChange={(isPlaying) => setPlayingId(isPlaying ? work.id : null)}
          />
        ) : (
          <span
            className={`work-row-play-badge${work.status === 'failed' ? ' is-failed' : ''}`}
            title={work.status === 'mixing' ? t('works.play.mixing') : t('works.status.failed')}
          >
            {work.status === 'mixing' ? <span className="spin" /> : '!'}
          </span>
        )}

        <div className="work-row-main">
          <div className="work-row-title">
            {renaming ? (
              <input
                className="text-input work-row-rename"
                value={renameDraft}
                autoFocus
                aria-label={t('works.rename.label')}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(work);
                  if (event.key === 'Escape') setRenamingId(null);
                }}
              />
            ) : (
              <span className="work-row-name" title={work.title}>
                {work.title}
              </span>
            )}

            {renaming ? (
              <span className="work-row-rename-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busyId === work.id || !renameDraft.trim()}
                  onClick={() => void commitRename(work)}
                >
                  {t('common.save')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRenamingId(null)}
                >
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <span className="work-row-status">
                {work.status === 'ready' && (
                  <>
                    <span className="work-row-dot is-ok" aria-hidden="true" />
                    {t('common.ready')}
                  </>
                )}
                {work.status === 'mixing' && (
                  <>
                    <span className="work-row-dot is-mixing" aria-hidden="true" />
                    {t('works.status.mixing')}
                  </>
                )}
                {work.status === 'failed' && (
                  <>
                    <span className="work-row-dot is-failed" aria-hidden="true" />
                    {t('works.status.failed')}
                  </>
                )}
              </span>
            )}
          </div>

          {/*
            元信息一行装完：伴奏 · 歌手 · 时长 · 大小 · 效果 · 时间。
            超长就截断，全文进 title —— 列表行要的是「一眼扫完一列」，
            不是把每首歌的档案摊开。
          */}
          <div
            className="work-row-meta"
            title={[
              work.trackTitle
                ? t('works.track.label', { title: work.trackTitle })
                : t('works.track.deleted'),
              work.trackArtist,
              t('works.meta.duration', { duration: formatDuration(work.vocalDuration) }),
              work.sizeBytes !== null
                ? t('works.meta.size', { size: formatBytes(work.sizeBytes, locale) })
                : '',
              t('works.meta.vocalPreset', { preset: presetLabel(locale, work.mixParams.vocalPreset) }),
              t('works.meta.reverb', {
                reverb: reverbSummary(locale, work.mixParams.reverbSpace, work.mixParams.reverbWet),
              }),
              t('works.meta.sungAt', { time: formatDateTime(work.createdAt, locale) }),
              remixHint.trim(),
              work.error ?? '',
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {work.trackTitle ? (
              <span className="work-row-track">
                {work.trackTitle}
                {work.trackArtist ? ` · ${work.trackArtist}` : ''}
              </span>
            ) : (
              <span className="work-row-track is-gone">{t('works.track.deleted')}</span>
            )}
            <span className="work-row-sep" aria-hidden="true">
              ·
            </span>
            <span className="mono">{formatDuration(work.vocalDuration)}</span>
            {work.sizeBytes !== null && (
              <>
                <span className="work-row-sep" aria-hidden="true">
                  ·
                </span>
                <span>{formatBytes(work.sizeBytes)}</span>
              </>
            )}
            <span className="work-row-sep" aria-hidden="true">
              ·
            </span>
            <span>
              {presetLabel(locale, work.mixParams.vocalPreset)} ·{' '}
              {reverbSummary(locale, work.mixParams.reverbSpace, work.mixParams.reverbWet)}
            </span>
            {/* 伴奏被移调过：这版的调和原文件不一样，得说出来 */}
            {work.trackPitchSemitones !== 0 && (
              <>
                <span className="work-row-sep" aria-hidden="true">
                  ·
                </span>
                <span title={t('works.pitch.shifted', { pitch: pitchLabel(locale, work.trackPitchSemitones) })}>
                  {pitchLabel(locale, work.trackPitchSemitones)}
                </span>
              </>
            )}
            <span className="work-row-sep" aria-hidden="true">
              ·
            </span>
            <span title={t('works.meta.sungAt', { time: formatDateTime(work.createdAt, locale) })}>
              {t('works.sung.relative', {
                when: formatRelativeTime(work.createdAt, undefined, locale),
              })}
            </span>
          </div>

          {work.status === 'failed' && (
            <div className="work-row-error">
              {t('works.mixFailedReason', { reason: work.error ?? t('common.unknown') })}
            </div>
          )}
        </div>

        <div className="work-row-actions">
          {renaming ? null : (
            <>
              <Link
                className="btn btn-sm"
                to={`/works/${work.id}`}
                title={t('works.action.adjustHint')}
              >
                {t('works.action.adjust')}
              </Link>
              {work.status === 'ready' ? (
                <a className="btn btn-sm" href={workAudioDownloadUrl(work.id)}>
                  {t('works.action.downloadMp3')}
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled
                  title={t('works.action.downloadDisabled')}
                >
                  {t('works.action.downloadMp3')}
                </button>
              )}
              <a
                className="btn btn-sm btn-ghost work-row-action-vocal work-row-action-soft"
                href={workVocalDownloadUrl(work.id)}
                title={t('works.action.vocalHint')}
              >
                {t('works.action.vocal')}
              </a>
              {work.status === 'failed' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId === work.id}
                  onClick={() => void handleRetry(work)}
                >
                  {t('works.action.retry')}
                </button>
              )}
              {/*
                改名 / 删除是低频且（删除）危险的操作：默认不占位置，
                行 hover 或键盘焦点落进行里才显形。触屏没有 hover，:focus-within
                兜底；而行本身可点进详情页，详情页里也有删除，不构成死角。
              */}
              <button
                type="button"
                className="btn btn-ghost btn-sm work-row-action-soft work-row-action-icon work-row-rename-trigger"
                aria-label={t('works.action.renameAria', { title: work.title })}
                title={t('works.action.rename')}
                onClick={() => {
                  setRenameDraft(work.title);
                  setRenamingId(work.id);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm work-row-action-soft work-row-action-icon is-danger"
                aria-label={t('works.action.deleteAria', { title: work.title })}
                title={t('common.delete')}
                onClick={() => void handleDelete(work)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {t('works.title')}
            {works.length > 0 && (
              <span className="page-count">
                {plural('works.count', works.length, { count: fmt.integer(works.length) })}
              </span>
            )}
          </h1>
          <p className="page-sub">{t('works.subtitle')}</p>
        </div>
        <Link className="btn" to="/">
          {t('works.goLibrary')}
        </Link>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* 工具栏：关键字 + 排序 + 状态过滤。作品攒到几十首之后，找某一首是高频动作 */}
      {!loading && works.length > 0 && (
        <div className="list-toolbar">
          <div className="search-with-icon">
            <span className="search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              ref={searchRef}
              className="text-input"
              value={query}
              placeholder={t('works.search.placeholder')}
              aria-label={t('works.search.aria')}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="search-clear"
                aria-label={t('works.search.clear')}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                ✕
              </button>
            )}
          </div>
          <select
            className="select-input"
            value={sortBy}
            aria-label={t('works.sort.aria')}
            onChange={(event) => setSortBy(event.target.value as WorksSortBy)}
          >
            <option value="recent">{t('works.sort.recent')}</option>
            <option value="oldest">{t('works.sort.oldest')}</option>
            <option value="title">{t('works.sort.title')}</option>
            <option value="duration">{t('works.sort.duration')}</option>
          </select>
          <div className="option-row work-status-filters">
            {STATUS_FILTERS.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                className={`filter-chip${statusFilter === value ? ' active' : ''}`}
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
              >
                {t(labelKey)}
                <span className="filter-chip-count">{fmt.integer(statusCounts[value])}</span>
              </button>
            ))}
          </div>
          <span className="list-count">
            {visibleWorks.length === works.length
              ? plural('works.count', works.length, { count: fmt.integer(works.length) })
              : plural('works.count.filtered', works.length, {
                  visible: fmt.integer(visibleWorks.length),
                  total: fmt.integer(works.length),
                })}
          </span>
        </div>
      )}

      {loading ? (
        <WorkSkeletonGrid />
      ) : works.length === 0 ? (
        <EmptyState
          icon="🎤"
          title={t('works.empty.title')}
          description={t('works.empty.description')}
          action={
            <Link className="btn btn-primary" to="/">
              {t('works.goLibrary')}
            </Link>
          }
        />
      ) : visibleWorks.length === 0 ? (
        <EmptyState
          icon="🔍"
          title={t('works.empty.noMatch.title')}
          description={
            query.trim()
              ? t('works.empty.noMatch.byQuery', { query: query.trim() })
              : t('works.empty.noMatch.byStatus')
          }
          action={
            <button type="button" className="btn" onClick={clearFilters}>
              {t('works.clearFilters')}
            </button>
          }
        />
      ) : (
        <div className="work-list">{visibleWorks.map(renderRow)}</div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { VOCAL_PRESET_LABELS } from '../../../shared/types';
import { describePitch, describeReverb } from '../../../shared/mix';
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

/** 状态过滤档位（chip 上带各自的数量） */
const STATUS_FILTERS: { value: WorkStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'ready', label: '已就绪' },
  { value: 'mixing', label: '合成中' },
  { value: 'failed', label: '失败' },
];

/** 重混 chip 的出现阈值：createdAt 与 updatedAt 差过 1 分钟才算「重新混过」 */
const REMIX_HINT_MS = 60_000;

export default function WorksPage() {
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
      setError(errorMessage(err, '加载作品失败'));
    } finally {
      setLoading(false);
    }
  }, []);

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
    () => selectVisibleWorks(works, { query, status: statusFilter, sortBy }),
    [works, query, statusFilter, sortBy],
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
      title: '删除作品',
      message: `确定删除作品「${work.title}」吗？录音干声和成品 MP3 都会一起删掉。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteWork(work.id);
      toast.ok(`已删除作品「${work.title}」`);
      if (renamingId === work.id) setRenamingId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, '删除失败'));
    }
  };

  /** 内联改名：Enter 提交、Esc 取消；空值前端先拦一道，服务端再兜底 */
  const commitRename = async (work: WorkListItem) => {
    const title = renameDraft.trim();
    if (!title) {
      toast.error('作品名不能为空');
      return;
    }
    setBusyId(work.id);
    try {
      await api.updateWork(work.id, { title });
      setRenamingId(null);
      toast.ok('已改名');
      await load();
    } catch (err) {
      // 失败保持编辑态：用户改完名字再试一次，不用从头点开
      toast.error(errorMessage(err, '重命名失败'));
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
      toast.error(errorMessage(err, '重试失败'));
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
      ? ` · 最近混音：${formatDateTime(work.updatedAt)}`
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
            title={work.status === 'mixing' ? '正在合成' : '合成失败'}
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
                aria-label="作品名"
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
                  保存
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRenamingId(null)}
                >
                  取消
                </button>
              </span>
            ) : (
              <span className="work-row-status">
                {work.status === 'ready' && (
                  <>
                    <span className="work-row-dot is-ok" aria-hidden="true" />
                    已就绪
                  </>
                )}
                {work.status === 'mixing' && (
                  <>
                    <span className="work-row-dot is-mixing" aria-hidden="true" />
                    合成中
                  </>
                )}
                {work.status === 'failed' && (
                  <>
                    <span className="work-row-dot is-failed" aria-hidden="true" />
                    合成失败
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
              work.trackTitle ? `伴奏：${work.trackTitle}` : '伴奏已删除',
              work.trackArtist,
              `时长 ${formatDuration(work.vocalDuration)}`,
              work.sizeBytes !== null ? `成品 MP3 ${formatBytes(work.sizeBytes)}` : '',
              `人声预设：${VOCAL_PRESET_LABELS[work.mixParams.vocalPreset]}`,
              `混响：${describeReverb(work.mixParams.reverbSpace, work.mixParams.reverbWet)}`,
              `演唱于 ${formatDateTime(work.createdAt)}`,
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
              <span className="work-row-track is-gone">伴奏已删除</span>
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
              {VOCAL_PRESET_LABELS[work.mixParams.vocalPreset]} ·{' '}
              {describeReverb(work.mixParams.reverbSpace, work.mixParams.reverbWet)}
            </span>
            {/* 伴奏被移调过：这版的调和原文件不一样，得说出来 */}
            {work.trackPitchSemitones !== 0 && (
              <>
                <span className="work-row-sep" aria-hidden="true">
                  ·
                </span>
                <span title={`混音时伴奏移调了 ${describePitch(work.trackPitchSemitones)}`}>
                  {describePitch(work.trackPitchSemitones)}
                </span>
              </>
            )}
            <span className="work-row-sep" aria-hidden="true">
              ·
            </span>
            <span title={`演唱于 ${formatDateTime(work.createdAt)}`}>
              {formatRelativeTime(work.createdAt)}演唱
            </span>
          </div>

          {work.status === 'failed' && (
            <div className="work-row-error">合成失败：{work.error ?? '未知原因'}</div>
          )}
        </div>

        <div className="work-row-actions">
          {renaming ? null : (
            <>
              <Link
                className="btn btn-sm"
                to={`/works/${work.id}`}
                title="试听效果、调整参数并重新合成"
              >
                调整效果
              </Link>
              {work.status === 'ready' ? (
                <a className="btn btn-sm" href={workAudioDownloadUrl(work.id)}>
                  下载 MP3
                </a>
              ) : (
                <button type="button" className="btn btn-sm" disabled title="作品还没就绪，不能下载">
                  下载 MP3
                </button>
              )}
              <a
                className="btn btn-sm btn-ghost work-row-action-vocal work-row-action-soft"
                href={workVocalDownloadUrl(work.id)}
                title="下载干声 WAV（未经处理的原始录音）"
              >
                干声
              </a>
              {work.status === 'failed' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId === work.id}
                  onClick={() => void handleRetry(work)}
                >
                  重试合成
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
                aria-label={`把「${work.title}」改名`}
                title="改名"
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
                aria-label={`删除「${work.title}」`}
                title="删除"
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
            我的作品
            {works.length > 0 && <span className="page-count">共 {works.length} 部</span>}
          </h1>
          <p className="page-sub">每唱一次都会存下一版 MP3，随时回听、下载或调整效果。</p>
        </div>
        <Link className="btn" to="/">
          去伴奏库
        </Link>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            重试
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
              placeholder="搜索作品名 / 伴奏 / 歌手…"
              aria-label="按作品名、伴奏名或歌手搜索作品"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="search-clear"
                aria-label="清空搜索词"
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
            aria-label="排序方式"
            onChange={(event) => setSortBy(event.target.value as WorksSortBy)}
          >
            <option value="recent">最近演唱</option>
            <option value="oldest">最早演唱</option>
            <option value="title">按歌名</option>
            <option value="duration">按时长</option>
          </select>
          <div className="option-row work-status-filters">
            {STATUS_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`filter-chip${statusFilter === value ? ' active' : ''}`}
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
              >
                {label}
                <span className="filter-chip-count">{statusCounts[value]}</span>
              </button>
            ))}
          </div>
          <span className="list-count">
            {visibleWorks.length === works.length
              ? `共 ${works.length} 部`
              : `${visibleWorks.length} / ${works.length} 部`}
          </span>
        </div>
      )}

      {loading ? (
        <WorkSkeletonGrid />
      ) : works.length === 0 ? (
        <EmptyState
          icon="🎤"
          title="还没有作品"
          description="去伴奏库选一首，戴上耳机开始你的第一次演唱吧。"
          action={
            <Link className="btn btn-primary" to="/">
              去伴奏库
            </Link>
          }
        />
      ) : visibleWorks.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="没有匹配的作品"
          description={
            query.trim()
              ? `没有和「${query.trim()}」相关的作品名、伴奏或歌手。`
              : '当前状态过滤下没有作品，换个状态看看。'
          }
          action={
            <button type="button" className="btn" onClick={clearFilters}>
              清空筛选
            </button>
          }
        />
      ) : (
        <div className="work-list">{visibleWorks.map(renderRow)}</div>
      )}
    </div>
  );
}

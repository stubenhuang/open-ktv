import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type WorkListItem } from '../../api';
import { VOCAL_PRESET_LABELS } from '../../../../shared/types';
import { coverGradient, errorMessage, formatDuration, formatRelativeTime, selectVisibleWorks } from '../../utils';

type StatusFilter = 'all' | WorkListItem['status'];
type SortBy = 'recent' | 'oldest' | 'title' | 'duration';

/**
 * 手机端作品库。
 *
 * 筛选/排序复用桌面那套纯函数（selectVisibleWorks）—— 口径必须一致，
 * 不然同一份作品在两个端口「搜出来不一样」会很困惑。列表行比桌面紧凑：
 * 封面色块 + 标题 + 伴奏 + 状态，点击进详情（试听 / 调效果 / 改名 / 删除）。
 */
export default function MobileWorksPage() {
  const [works, setWorks] = useState<WorkListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('recent');

  useEffect(() => {
    let cancelled = false;
    api
      .listWorks()
      .then((list) => {
        if (!cancelled) setWorks(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, '加载作品失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () => selectVisibleWorks(works, { query, status, sortBy }),
    [works, query, status, sortBy],
  );

  return (
    <div className="m-page">
      <header className="m-head">
        <div>
          <h1 className="m-title">🎤 我的作品</h1>
          <p className="m-sub">共 {works.length} 首 · 唱完的作品在这里调效果、下载</p>
        </div>
      </header>

      {error && (
        <div className="m-alert m-alert-error">
          {error}
          <button type="button" className="m-btn m-btn-ghost m-btn-sm" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      )}

      <div className="m-search">
        <input
          className="m-input"
          type="search"
          value={query}
          placeholder="搜作品名 / 伴奏 / 歌手"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="m-chip-row">
        {(
          [
            ['all', '全部'],
            ['ready', '已就绪'],
            ['mixing', '合成中'],
            ['failed', '失败'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`m-chip${status === value ? ' active' : ''}`}
            onClick={() => setStatus(value)}
          >
            {label}
          </button>
        ))}
        <span className="m-chip-row-spacer" />
        <select
          className="m-select m-select-inline"
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as SortBy)}
          aria-label="排序"
        >
          <option value="recent">最近演唱</option>
          <option value="oldest">最早演唱</option>
          <option value="title">按歌名</option>
          <option value="duration">按时长</option>
        </select>
      </div>

      {loading && <div className="m-empty">正在加载作品…</div>}

      {!loading && visible.length === 0 && (
        <div className="m-empty">
          {works.length === 0 ? '还没有作品。去伴奏库选一首开唱吧。' : '没有匹配的作品。'}
        </div>
      )}

      <ul className="m-track-list">
        {visible.map((work) => (
          <li key={work.id}>
            <Link className="m-track" to={`/m/work/${work.id}`}>
              {/*
                封条改首字（和桌面 .work-row-cover 一个语言）：原来是一枚通用 🎤，
                九行九个一样的话筒，等于没有信息。
              */}
              <span className="m-work-cover" style={{ background: coverGradient(work.title) }} aria-hidden="true">
                {work.status === 'mixing' ? (
                  <span className="spin" />
                ) : (
                  <span className="m-work-cover-char">{Array.from(work.title)[0] ?? '♪'}</span>
                )}
              </span>
              <span className="m-track-main">
                <span className="m-track-title">{work.title}</span>
                {/* 元信息补齐成桌面那一套：伴奏 · 时长 · 效果 · 时间 */}
                <span className="m-track-meta">
                  {work.trackTitle ?? '伴奏已删除'}
                  {work.trackArtist ? ` · ${work.trackArtist}` : ''} ·{' '}
                  {formatDuration(work.vocalDuration)} ·{' '}
                  {VOCAL_PRESET_LABELS[work.mixParams.vocalPreset]} ·{' '}
                  {formatRelativeTime(work.createdAt)}
                </span>
              </span>
              {/* 状态改「点 + 字」：原来右侧一个药丸徽章，和封条、标题三件套打架 */}
              <span className={`m-work-status is-${work.status}`}>
                <span className="m-work-status-dot" aria-hidden="true" />
                {work.status === 'ready' ? '已就绪' : work.status === 'mixing' ? '合成中' : '失败'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type WorkListItem } from '../../api';
import { presetLabel } from '../../i18n/labels';
import { useI18n } from '../../i18n';
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
  const { t, fmt, plural, locale } = useI18n();
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
        if (!cancelled) setError(errorMessage(err, t('mobile.load_works_failed')));
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
          <h1 className="m-title">{t('mobile.works.title')}</h1>
          <p className="m-sub">
            {plural('mobile.works.count_note', works.length, { count: fmt.integer(works.length) })}
          </p>
        </div>
      </header>

      {error && (
        <div className="m-alert m-alert-error">
          {error}
          <button type="button" className="m-btn m-btn-ghost m-btn-sm" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="m-search">
        <input
          className="m-input"
          type="search"
          value={query}
          placeholder={t('mobile.works.search_placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="m-chip-row">
        {(
          [
            ['all', t('common.all')],
            ['ready', t('common.ready')],
            ['mixing', t('mobile.status.mixing')],
            ['failed', t('common.failed')],
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
          aria-label={t('mobile.works.sort_label')}
        >
          <option value="recent">{t('mobile.works.sort_recent')}</option>
          <option value="oldest">{t('mobile.works.sort_oldest')}</option>
          <option value="title">{t('mobile.works.sort_title')}</option>
          <option value="duration">{t('mobile.works.sort_duration')}</option>
        </select>
      </div>

      {loading && <div className="m-empty">{t('mobile.works.loading')}</div>}

      {!loading && visible.length === 0 && (
        <div className="m-empty">
          {works.length === 0 ? t('mobile.works.empty') : t('mobile.works.no_match')}
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
                  <span className="m-work-cover-char">
                    {Array.from(work.title)[0] ?? t('mobile.works.cover_fallback')}
                  </span>
                )}
              </span>
              <span className="m-track-main">
                <span className="m-track-title">{work.title}</span>
                {/* 元信息补齐成桌面那一套：伴奏 · 时长 · 效果 · 时间 */}
                <span className="m-track-meta">
                  {work.trackTitle ?? t('mobile.works.track_deleted')}
                  {work.trackArtist ? ` · ${work.trackArtist}` : ''} ·{' '}
                  {formatDuration(work.vocalDuration)} ·{' '}
                  {presetLabel(locale, work.mixParams.vocalPreset)} ·{' '}
                  {formatRelativeTime(work.createdAt, Date.now(), locale)}
                </span>
              </span>
              {/* 状态改「点 + 字」：原来右侧一个药丸徽章，和封条、标题三件套打架 */}
              <span className={`m-work-status is-${work.status}`}>
                <span className="m-work-status-dot" aria-hidden="true" />
                {work.status === 'ready'
                  ? t('common.ready')
                  : work.status === 'mixing'
                    ? t('mobile.status.mixing')
                    : t('common.failed')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackListItem } from '../../api';
import { api } from '../../api';
import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { errorMessage, formatDuration } from '../../utils';

/**
 * 手机端首页：选歌。
 *
 * 就是「伴奏库的手机版」—— 只列能唱的（ready），搜索在本地做
 * （自己家几十首，不值得为它打接口，和桌面端口径一致）。
 */
export default function MobileHomePage() {
  const { t, fmt, plural } = useI18n();
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .listTracks()
      .then((list) => {
        if (!cancelled) setTracks(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, t('mobile.load_tracks_failed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const ready = tracks.filter((track) => track.status === 'ready');
    const keyword = query.trim().toLowerCase();
    if (!keyword) return ready;
    return ready.filter((track) => {
      const title = track.title?.toLowerCase() ?? '';
      const artist = track.artist?.toLowerCase() ?? '';
      return title.includes(keyword) || artist.includes(keyword);
    });
  }, [tracks, query]);

  const pendingCount = tracks.filter((track) => track.status !== 'ready').length;

  return (
    <div className="m-page">
      <header className="m-head">
        <div>
          <h1 className="m-title">{t('mobile.home.title')}</h1>
          <p className="m-sub">
            {t('mobile.home.connected', {
              host: typeof location !== 'undefined' ? location.host : '',
            })}
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
          placeholder={t('mobile.home.search_placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {loading && <div className="m-empty">{t('mobile.home.loading')}</div>}

      {!loading && !error && visible.length === 0 && (
        <div className="m-empty">
          {tracks.length === 0 ? (
            <>
              <p>{t('mobile.home.empty_library')}</p>
              <p>{t('mobile.home.empty_library_hint')}</p>
              <div className="m-rec-actions" style={{ marginTop: 12 }}>
                <Link className="m-btn m-btn-primary m-btn-record" to="/m/discover">
                  {t('mobile.home.go_discover')}
                </Link>
                <Link className="m-btn m-btn-ghost m-btn-record" to="/m/works">
                  {t('mobile.home.go_works')}
                </Link>
              </div>
            </>
          ) : (
            t('mobile.home.no_match', { query })
          )}
        </div>
      )}

      <ul className="m-track-list">
        {visible.map((track) => (
          <li key={track.id}>
            <Link className="m-track" to={`/m/sing/${track.id}`}>
              <span className="m-track-icon" aria-hidden="true">
                {track.kind === 'video' ? '🎬' : '🎵'}
              </span>
              <span className="m-track-main">
                <span className="m-track-title">{track.title}</span>
                <span className="m-track-meta">
                  {track.artist ? `${track.artist} · ` : ''}
                  {formatDuration(track.duration)}
                  {track.hasLyrics ? t('mobile.track.has_lyrics') : ''}
                </span>
              </span>
              <span className="m-track-go" aria-hidden="true">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {pendingCount > 0 && (
        <p className="m-foot-note">
          {plural('mobile.home.pending_note', pendingCount, { count: fmt.integer(pendingCount) })}
        </p>
      )}
      <p className="m-foot-note">{t('mobile.home.foot_note')}</p>
    </div>
  );
}

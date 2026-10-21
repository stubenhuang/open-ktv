//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackListItem } from '../../api';
import { api } from '../../api';
import { useEffect } from 'react';
import { errorMessage, formatDuration } from '../../utils';

/**
 * 手机端首页：选歌。
 *
 * 就是「伴奏库的手机版」—— 只列能唱的（ready），搜索在本地做
 * （自己家几十首，不值得为它打接口，和桌面端口径一致）。
 */
export default function MobileHomePage() {
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
        if (!cancelled) setError(errorMessage(err, '加载伴奏失败'));
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
          <h1 className="m-title">🎤 选首歌开唱</h1>
          <p className="m-sub">
            已连接 {typeof location !== 'undefined' ? location.host : ''}
          </p>
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
          placeholder="搜歌名 / 歌手"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {loading && <div className="m-empty">正在加载伴奏…</div>}

      {!loading && !error && visible.length === 0 && (
        <div className="m-empty">
          {tracks.length === 0 ? (
            <>
              <p>曲库还是空的。</p>
              <p>去电脑端上传伴奏，或在「点歌」里搜一首直接入库。</p>
              <div className="m-rec-actions" style={{ marginTop: 12 }}>
                <Link className="m-btn m-btn-primary m-btn-record" to="/m/discover">
                  去点歌台
                </Link>
                <Link className="m-btn m-btn-ghost m-btn-record" to="/m/works">
                  看作品
                </Link>
              </div>
            </>
          ) : (
            `没有匹配「${query}」的伴奏。`
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
                  {track.hasLyrics ? ' · 有歌词' : ''}
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
        <p className="m-foot-note">另有 {pendingCount} 首正在转码或处理失败，手机上先不列。</p>
      )}
      <p className="m-foot-note">唱完的作品会进「我的作品」，电脑端可以调效果、下载 MP3。</p>
    </div>
  );
}

//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, networkCertUrl, networkQrUrl, type NetworkInfo } from '../api';
import { buildMobileUrls } from '../utils';

/**
 * 导航栏右侧的「📱 手机演唱」hover 菜单。
 *
 * 为什么在导航栏而不是某个页面里：二维码入口是**全局能力** —— 在伴奏库选歌时、
 * 在演唱页准备开唱时都可能要递手机。放导航栏右上角，所有桌面页面都够得着，
 * 又不用在每个页面占一块正文。悬停 / 键盘聚焦 / 点击都能展开（触屏靠点击）。
 *
 * 数据来自 GET /api/network：服务端如实报告「现在有没有可用入口、是什么协议」，
 * 所以菜单要能说清楚三件事 ——
 *   1. 正常：二维码 + 地址列表 + 证书信任提示；
 *   2. 入口是 http：手机浏览器会禁用麦克风（安全上下文限制），给出修复办法；
 *   3. 没有入口（没网卡 / 证书没签到）：说原因，别给个扫不开的码。
 *
 * 懒加载：第一次被唤起才请求，之后复用（菜单里可以手动刷新）——
 * 否则每次切页面都白打一次接口。
 */
export function PhoneConnectMenu() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 是否已经请求过（请求过一次之后就不再自动重拉） */
  const requestedRef = useRef(false);

  const load = useCallback(() => {
    requestedRef.current = true;
    api
      .getNetwork()
      .then(setInfo)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取网络信息失败'));
  }, []);

  // 悬停 / 聚焦时按需拉一次
  const ensureLoaded = useCallback(() => {
    if (requestedRef.current) return;
    load();
  }, [load]);

  // 点页面别处收起；Esc 也收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      /*
       * 必须同时让按钮失焦：菜单还有一条 `:focus-within` 的显示规则
       * （键盘用户 Tab 到按钮就该看到内容）。点过的按钮会一直持有焦点，
       * 只把 open 置 false 的话菜单会被 focus-within 继续挂着，Esc 按了没反应。
       */
      triggerRef.current?.blur();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 地址展开走共享纯函数（服务端已经判断好协议/端口，这里只做「地址 × 入口」乘法）
  const urls = info ? buildMobileUrls(info) : [];
  const hasEntry = urls.length > 0 && Boolean(info?.mobileUrl);

  return (
    <div
      ref={wrapRef}
      className={`app-nav-phone${open ? ' open' : ''}`}
      onPointerEnter={ensureLoaded}
      onFocus={ensureLoaded}
    >
      <button
        ref={triggerRef}
        type="button"
        className="app-nav-phone-btn"
        aria-label="手机演唱：扫码用手机唱歌"
        aria-expanded={open}
        onClick={() => {
          ensureLoaded();
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">📱</span>
      </button>

      <div className="phone-menu" role="dialog" aria-label="手机演唱">
        <div className="phone-menu-head">
          <span className="phone-menu-title">📱 手机演唱</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setError(null);
              load();
            }}
          >
            刷新
          </button>
        </div>

        {error && <div className="phone-menu-error">{error}</div>}
        {!info && !error && <div className="phone-menu-hint">正在读取局域网地址…</div>}

        {info && !hasEntry && (
          <div className="phone-menu-error">
            {info.reason ?? '现在没有可用的手机入口。'}
          </div>
        )}

        {info && hasEntry && (
          <>
            <div className="phone-menu-qr">
              <img src={networkQrUrl()} alt="扫码用手机演唱" width={148} height={148} />
            </div>
            <p className="phone-menu-hint">手机连同一个 WiFi，扫码即开移动端演唱页。</p>
            {info.tokenRequired && (
              <p className="phone-menu-hint">
                服务开启了访问保护，二维码地址里已带上令牌，手机扫码即用、无需手输。
              </p>
            )}
            {info.micBlocked && (
              <div className="phone-menu-error">⚠️ {info.reason ?? 'http 入口下手机浏览器会禁用麦克风。'}</div>
            )}
            {info.selfSigned && !info.micBlocked && (
              <p className="phone-menu-hint">
                首次打开提示「证书不受信任」：点<strong>高级 → 继续访问</strong>
                （iPhone：显示详细信息 → 访问网站）。
                <a className="link-btn" href={networkCertUrl()} target="_blank" rel="noreferrer">
                  下载证书
                </a>
              </p>
            )}
            <ul className="phone-menu-urls">
              {urls.map((url) => (
                <li key={url}>
                  <code className="phone-menu-url">{url}</code>
                </li>
              ))}
            </ul>
            <p className="phone-menu-hint">建议戴耳机唱：外放伴奏会被麦克风收进去。</p>
          </>
        )}
      </div>
    </div>
  );
}

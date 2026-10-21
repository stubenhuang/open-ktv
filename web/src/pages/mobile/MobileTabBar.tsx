//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { NavLink } from 'react-router-dom';
import { useI18n } from '../../i18n';

/**
 * 手机端底部 tab 栏：伴奏 / 点歌 / 作品。
 *
 * 只在三个列表页面显示（演唱页和作品详情是「沉浸/聚焦」场景，tab 栏会挡事）——
 * 由 MobileLayout 按路由决定挂不挂。
 */
const TABS = [
  { to: '/m', labelKey: 'mobile.tab.tracks', icon: '🎵' },
  { to: '/m/discover', labelKey: 'mobile.tab.discover', icon: '🔍' },
  { to: '/m/works', labelKey: 'mobile.tab.works', icon: '🎤' },
] as const;

export function MobileTabBar() {
  const { t } = useI18n();
  return (
    <nav className="m-tabbar" aria-label={t('mobile.tabbar.aria')}>
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/m'}
          className={({ isActive }) => `m-tab${isActive ? ' active' : ''}`}
        >
          <span className="m-tab-icon" aria-hidden="true">
            {tab.icon}
          </span>
          <span className="m-tab-label">{t(tab.labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

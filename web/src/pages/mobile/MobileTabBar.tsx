import { NavLink } from 'react-router-dom';

/**
 * 手机端底部 tab 栏：伴奏 / 点歌 / 作品。
 *
 * 只在三个列表页面显示（演唱页和作品详情是「沉浸/聚焦」场景，tab 栏会挡事）——
 * 由 MobileLayout 按路由决定挂不挂。
 */
const TABS = [
  { to: '/m', label: '伴奏', icon: '🎵' },
  { to: '/m/discover', label: '点歌', icon: '🔍' },
  { to: '/m/works', label: '作品', icon: '🎤' },
] as const;

export function MobileTabBar() {
  return (
    <nav className="m-tabbar" aria-label="手机端主导航">
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
          <span className="m-tab-label">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

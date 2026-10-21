//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConfirmHost } from '../../components/ConfirmDialog';
import { ToastStack } from '../../components/ToastStack';
import { TokenGate } from '../../components/TokenGate';
import MobileDiscoverPage from './MobileDiscoverPage';
import MobileHomePage from './MobileHomePage';
import MobileSingPage from './MobileSingPage';
import { MobileTabBar } from './MobileTabBar';
import MobileWorkEditPage from './MobileWorkEditPage';
import MobileWorkPage from './MobileWorkPage';
import MobileWorksPage from './MobileWorksPage';
import '../../mobile.css';

/**
 * 手机端外壳。
 *
 * 与桌面端的最大区别：**没有导航栏**。手机屏幕一寸一寸都是钱，
 * 而这些页面本来就该全屏。toast / 确认框仍然挂着 —— 上传完成、删除确认
 * 这类反馈和桌面共用一套 API。
 *
 * 路由（App.tsx 按 /m 前缀切过来）：
 *   /m                      伴奏库（本地搜索 + 列表）
 *   /m/discover             点歌台（曲库搜索 + 点歌）
 *   /m/works                我的作品
 *   /m/sing/:trackId        演唱页（沉浸）
 *   /m/work/:workId         作品结果 / 详情
 *   /m/work/:workId/edit    效果调整（实时试听 + 合成）
 *
 * 底部 tab 栏只挂在三个列表页上：演唱和编辑是要专心做的事，tab 栏只会挡事。
 */
export default function MobileLayout() {
  const { pathname } = useLocation();
  const showTabBar =
    pathname === '/m' || pathname === '/m/discover' || pathname === '/m/works';

  return (
    <div className={`m-app${showTabBar ? ' m-app-tabbed' : ''}`}>
      <Routes>
        <Route path="/m" element={<MobileHomePage />} />
        <Route path="/m/discover" element={<MobileDiscoverPage />} />
        <Route path="/m/works" element={<MobileWorksPage />} />
        <Route path="/m/sing/:trackId" element={<MobileSingPage />} />
        <Route path="/m/work/:workId" element={<MobileWorkPage />} />
        <Route path="/m/work/:workId/edit" element={<MobileWorkEditPage />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
      {showTabBar && <MobileTabBar />}
      <ToastStack />
      <ConfirmHost />
      {/* 令牌闸门：正常扫码进入不会出现（URL 上就带令牌）；令牌失效时才需要手输 */}
      <TokenGate />
    </div>
  );
}

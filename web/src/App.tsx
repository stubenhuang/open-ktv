import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import DiscoverPage from './pages/DiscoverPage';
import LibraryPage from './pages/LibraryPage';
import SingPage from './pages/SingPage';
import WorkDetailPage from './pages/WorkDetailPage';
import WorksPage from './pages/WorksPage';

/** 作品编辑页：/works/:workId（编辑页要求「一屏放完」，见 .app-main-fit） */
const WORK_DETAIL_RE = /^\/works\/[^/]+$/;

function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // 编辑页自己管高度：不吃 .app-main 那 72px 的底部滚动余量，否则一屏放不下
  const fitOneScreen = WORK_DETAIL_RE.test(pathname);
  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-brand">
          <span className="app-brand-dot" />
          Open KTV
        </div>
        <div className="app-nav-links">
          <NavLink to="/" end className={({ isActive }) => `app-nav-link${isActive ? ' active' : ''}`}>
            伴奏库
          </NavLink>
          <NavLink
            to="/discover"
            className={({ isActive }) => `app-nav-link${isActive ? ' active' : ''}`}
          >
            点歌台
          </NavLink>
          <NavLink
            to="/works"
            className={({ isActive }) => `app-nav-link${isActive ? ' active' : ''}`}
          >
            我的作品
          </NavLink>
        </div>
      </nav>
      <main className={`app-main${fitOneScreen ? ' app-main-fit' : ''}`}>{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/sing/:trackId" element={<SingPage />} />
        <Route path="/works" element={<WorksPage />} />
        <Route path="/works/:workId" element={<WorkDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import LibraryPage from './pages/LibraryPage';
import SingPage from './pages/SingPage';
import WorkDetailPage from './pages/WorkDetailPage';
import WorksPage from './pages/WorksPage';

function Layout({ children }: { children: ReactNode }) {
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
            to="/works"
            className={({ isActive }) => `app-nav-link${isActive ? ' active' : ''}`}
          >
            我的作品
          </NavLink>
        </div>
      </nav>
      <main className="app-main">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/sing/:trackId" element={<SingPage />} />
        <Route path="/works" element={<WorksPage />} />
        <Route path="/works/:workId" element={<WorkDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

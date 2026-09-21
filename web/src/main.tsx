import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 节点，index.html 被改坏了？');

// 这里刻意不套 React.StrictMode：
// StrictMode 会把 effect 跑两遍，而 Web Audio 的 createMediaElementSource
// 对同一个 <video> 元素只能调用一次，双挂载会直接把它踩爆。
createRoot(container).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);

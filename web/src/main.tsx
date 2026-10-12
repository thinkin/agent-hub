import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import { applyTheme } from './theme';
applyTheme();
function resizeViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale === 1) document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
}
window.visualViewport?.addEventListener('resize', resizeViewport);
window.addEventListener('resize', resizeViewport);
resizeViewport();
createRoot(document.getElementById('root')!).render(<App />);

import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import { applyTheme, storedTheme } from './theme';
applyTheme(storedTheme());
createRoot(document.getElementById('root')!).render(<App />);

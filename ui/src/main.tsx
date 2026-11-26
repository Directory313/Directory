import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'flexlayout-react/style/dark.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';

// Disable the WebView's default context menu outside text inputs (VEYRA has its own menus).
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

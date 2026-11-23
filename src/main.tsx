import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { scheduleGestureDiagnostics } from './services/gestureDiagnostics';

createRoot(document.getElementById('root')!).render(<App />);

// Depois do app montar: publica `window.__LIORA_GESTURE__` para inspeção no
// console do WebView (getDiagnostics/getLastAnalysis). Isolado em chunk
// assíncrono para nunca derrubar a UI se o módulo de visão falhar.
scheduleGestureDiagnostics();

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { getRuntimeConfig } from './config/runtimeConfig';
import { installPerfGlobals } from './perf/metrics';
import { installEvalApi } from './perf/evalApi';
import { useKbStore } from './store/kbStore';

const runtimeConfig = getRuntimeConfig();

// ?perf=1 才暴露观测/评测入口（契约第 3 节）
if (runtimeConfig.perf) {
  installPerfGlobals();
  installEvalApi();
}

// URL ?collection= 优先于 localStorage 中的 activeCollection
if (runtimeConfig.collection) {
  useKbStore.getState().setActiveCollection(runtimeConfig.collection);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles/globals.css';

const root = createRoot(document.getElementById('root')!);

// Dev-only harness entry point (TASK-L2a): `import.meta.env.DEV` is statically `false` in a
// production build, so Vite/Rollup dead-code-eliminates this whole branch -- including the
// dynamic import -- out of the built bundle entirely. Reached via `?dev_wrapup=1` in `npm run
// dev` only; never wired into the real app's routing (that stays TASK-L2b's job).
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('dev_wrapup')) {
  import('./dev/WrapUpModalHarness.tsx').then(({ WrapUpModalHarness }) => {
    root.render(<WrapUpModalHarness />);
  });
} else {
  root.render(<App />);
}

import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles/globals.css';

const root = createRoot(document.getElementById('root')!);

// Dev-only harness entry points: `import.meta.env.DEV` is statically `false` in a production
// build, so Vite/Rollup dead-code-eliminates these whole branches -- including the dynamic
// imports -- out of the built bundle entirely.
const devHarness = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
if (devHarness?.has('dev_wrapup')) {
  // TASK-L2a: WrapUpModal in isolation, fixture dispositions. `?dev_wrapup=1`
  // (`&dev_wrapup_fail=1` to exercise the submit-error retry path).
  import('./dev/WrapUpModalHarness.tsx').then(({ WrapUpModalHarness }) => {
    root.render(<WrapUpModalHarness />);
  });
} else if (devHarness?.has('dev_dialer_states')) {
  // TASK-L2b: every dial_sessions.state rendered against ParallelDialerUI/DialerStateBanner/
  // WrapUpModal with fixture data, no live session/DB. `?dev_dialer_states=1`.
  import('./dev/DialerStatesHarness.tsx').then(({ DialerStatesHarness }) => {
    root.render(<DialerStatesHarness />);
  });
} else if (devHarness?.has('dev_start_session')) {
  // TASK-L7: StartSessionPanel's own states (no campaigns/list/pre-flight failing/starting/
  // 409 conflict) with fixture data, no live session/DB. `?dev_start_session=1`.
  import('./dev/StartSessionHarness.tsx').then(({ StartSessionHarness }) => {
    root.render(<StartSessionHarness />);
  });
} else if (devHarness?.has('dev_incoming_call')) {
  // TASK-I1 (INB-2): IncomingCallBanner in isolation, fixture caller, no live WebRTC/DB.
  // `?dev_incoming_call=1`.
  import('./dev/IncomingCallHarness.tsx').then(({ IncomingCallHarness }) => {
    root.render(<IncomingCallHarness />);
  });
} else if (devHarness?.has('dev_webrtc_retry')) {
  // TASK-I1 review fix (eng1 finding #2): the WebRTC connect-retry backoff's pure math,
  // rendered directly (no test runner exists for the web client). `?dev_webrtc_retry=1`.
  import('./dev/WebrtcRetryHarness.tsx').then(({ WebrtcRetryHarness }) => {
    root.render(<WebrtcRetryHarness />);
  });
} else if (devHarness?.has('dev_billing')) {
  // TASK-BF1: AddFundsDialog/AutoRechargeSection/RecentBillingActivity against fixture data, no
  // live Telnyx/DB. `?dev_billing=1` (`&dev_billing_error=card_declined|no_payment_method|
  // forbidden_key|rate_limited` to exercise an add-funds error state).
  import('./dev/BillingHarness.tsx').then(({ BillingHarness }) => {
    root.render(<BillingHarness />);
  });
} else if (devHarness?.has('dev_shifts')) {
  // TASK-F01: the intern Shifts screen against fixture data, no live backend.
  // `?dev_shifts=1&scenario=default|unsubmitted|under_minimum|deadline_passed|power_week|empty|
  // disabled|error|slow|withdraw_error|submit_*|request_pending|request_started|request_500|update_overlap`.
  // Add `&view=team` for the Team Shifts (manager) screen.
  import('./dev/ShiftsHarness.tsx').then(({ ShiftsHarness }) => {
    root.render(<ShiftsHarness />);
  });
} else {
  root.render(<App />);
}

import { createRoot } from 'react-dom/client';
import { proFormTokenFromPath } from './lib/proForm.ts';
import './styles/globals.css';
import { installVisualViewportVars } from './lib/visualViewport.ts';

installVisualViewportVars();
const root = createRoot(document.getElementById('root')!);

// Dev-only harness entry points: `import.meta.env.DEV` is statically `false` in a production
// build, so Vite/Rollup dead-code-eliminates these whole branches -- including the dynamic
// imports -- out of the built bundle entirely.
const devHarness = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
const proFormToken = proFormTokenFromPath(window.location.pathname);
if (proFormToken) {
  // TASK-H29: the public pro form (/join/:token). It is rendered WITHOUT loading App, so the Supabase client
  // (session recovery, token refresh, auth providers) is never even imported for a visitor.
  import('./components/join/ProFormPage.tsx').then(({ ProFormPage }) => {
    root.render(<ProFormPage token={proFormToken} />);
  });
} else if (devHarness?.has('dev_wrapup')) {
  // TASK-L2a: WrapUpModal in isolation, fixture dispositions. `?dev_wrapup=1`
  // (`&dev_wrapup_fail=1` to exercise the submit-error retry path).
  import('./dev/WrapUpModalHarness.tsx').then(({ WrapUpModalHarness }) => {
    import('./dev/DevAuth.tsx').then(({ DevAuth }) =>
      root.render(
        <DevAuth>
          <WrapUpModalHarness />
        </DevAuth>
      )
    );
  });
} else if (devHarness?.has('dev_log_close')) {
  // TASK-H03: LogCloseModal with fixture data. `?dev_log_close=1&scenario=normal|nocats|slow|fail|badprefill|notconfigured|failed`.
  import('./dev/LogCloseHarness.tsx').then(({ LogCloseHarness }) => {
    import('./dev/DevAuth.tsx').then(({ DevAuth }) =>
      root.render(
        <DevAuth>
          <LogCloseHarness />
        </DevAuth>
      )
    );
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
    import('./dev/DevAuth.tsx').then(({ DevAuth }) =>
      root.render(
        <DevAuth>
          <StartSessionHarness />
        </DevAuth>
      )
    );
  });
} else if (devHarness?.has('dev_incoming_call')) {
  // TASK-I1 (INB-2): IncomingCallBanner in isolation, fixture caller, no live WebRTC/DB.
  // `?dev_incoming_call=1`.
  import('./dev/IncomingCallHarness.tsx').then(({ IncomingCallHarness }) => {
    import('./dev/DevAuth.tsx').then(({ DevAuth }) =>
      root.render(
        <DevAuth>
          <IncomingCallHarness />
        </DevAuth>
      )
    );
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
} else if (devHarness?.has('dev_ghl_reconcile')) {
  // TASK-G12: the Settings "Remove from call lists" card against fixtures. `?dev_ghl_reconcile=1`
  // (`&scenario=fresh|failed_run|load_error|save_error|stages_error|slow`).
  import('./dev/GhlReconcileHarness.tsx').then(({ GhlReconcileHarness }) => {
    root.render(<GhlReconcileHarness />);
  });
} else if (devHarness?.has('dev_ghl_fields')) {
  // TASK-G17: the Settings "Field coverage" card against fixtures. `?dev_ghl_fields=1`
  // (`&scenario=none|all|error|slow`).
  import('./dev/GhlFieldCoverageHarness.tsx').then(({ GhlFieldCoverageHarness }) => {
    root.render(<GhlFieldCoverageHarness />);
  });
} else if (devHarness?.has('dev_ghl_webhook')) {
  // TASK-G30: the Settings "Instant updates" card against fixtures. `?dev_ghl_webhook=1`
  // (`&scenario=fresh|configured|reconcile_off|load_error|action_error|slow`).
  import('./dev/GhlWebhookHarness.tsx').then(({ GhlWebhookHarness }) => {
    root.render(<GhlWebhookHarness />);
  });
} else if (devHarness?.has('dev_contact_import')) {
  // TASK-H01: CSV import modal (unmatched columns -> custom fields) and the contact modal's custom values. `?dev_contact_import=1&view=import|detail`.
  import('./dev/ContactImportHarness.tsx').then(({ ContactImportHarness }) => {
    root.render(<ContactImportHarness />);
  });
} else if (devHarness?.has('dev_contact_dnc')) {
  // TASK-G31: the contact modal's do-not-call control per role. `?dev_contact_dnc=1&role=agent|admin|owner&dnc=1|0`.
  import('./dev/ContactDncHarness.tsx').then(({ ContactDncHarness }) => {
    root.render(<ContactDncHarness />);
  });
} else if (devHarness?.has('dev_post_call')) {
  // TASK-H27: the post-call card (outcome chips, notes, Save). `?dev_post_call=1&record=ok|fail`.
  import('./dev/PostCallHarness.tsx').then(({ PostCallHarness }) => {
    import('./dev/DevAuth.tsx').then(({ DevAuth }) =>
      root.render(
        <DevAuth>
          <PostCallHarness />
        </DevAuth>
      )
    );
  });
} else if (devHarness?.has('dev_recording_player')) {
  // TASK-H33: the shared RecordingPlayer alone. `?dev_recording_player=1&src=<mp3 url>`.
  import('./dev/RecordingPlayerHarness.tsx').then(({ RecordingPlayerHarness }) => {
    root.render(<RecordingPlayerHarness />);
  });
} else if (devHarness?.has('dev_wakelock')) {
  // TASK-MOB5: useScreenWakeLock on real iOS Safari. `?dev_wakelock=1`.
  import('./dev/WakeLockHarness.tsx').then(({ WakeLockHarness }) => {
    root.render(<WakeLockHarness />);
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
  import('./App.tsx').then(({ default: App }) => {
    root.render(<App />);
  });
}

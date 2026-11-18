/**
 * Per-org Telnyx REST client (BYO key, design §3). No env-level API key inside —
 * every call receives the caller's own key via `createTelnyxClient(apiKey)`, since
 * each org supplies its own Telnyx account.
 *
 * Parameter names, required fields and enums below were verified 2026-09-23 against
 * Telnyx's published OpenAPI spec (the `developers.telnyx.com` API-reference pages
 * for these endpoints 404 through automated fetch; the spec is Telnyx's own primary
 * source, generated from the same definitions):
 *   https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json
 * Schemas checked: CallRequest, TranscriptionStartRequest, "Start Recording Request"
 * (record_start), the conference join-participant request, the speak request, and the
 * create request bodies for call_control_applications, outbound_voice_profiles,
 * credential_connections, telephony_credentials and number_orders.
 *
 * One correction versus the salvaged `_shared/telnyx.ts`: there is no
 * `/calls/{id}/actions/join_conference` endpoint in the current spec (verified: zero
 * matches for "join_conference" in spec3.json). The current API joins a call into a
 * conference via `POST /conferences/{id}/actions/join` with `call_control_id` in the
 * body, which is what `joinConference` below calls. Flagged in
 * `.brain/memory/known-issues.md` for TASK-P1-05, which switches the engine over to
 * this client.
 *
 * find*ByName (added for the TASK-P1-05 fix, 2026-09-24): list-endpoint filter params,
 * also verified against spec3.json's `components.parameters`: outbound_voice_profiles
 * takes only `filter[name][contains]`; call_control_applications takes
 * `filter[application_name][contains]`; credential_connections takes the exact-match
 * `filter[connection_name]` (no `[contains]`). All three are substring-or-exact
 * server-side filters, so callers still compare the returned name field for an exact
 * match before treating a result as "found" -- see the implementations below.
 *
 * findTelephonyCredentialByName (TASK-P1-06): telephony_credentials' list endpoint takes
 * a consolidated `filter[name]` (deepObject style, no documented `[contains]` suffix --
 * verified against spec3.json's `telephony-credentials_FilterConsolidated` parameter).
 * Same "compare the returned name for an exact match" discipline as the other three.
 *
 * mintCredentialToken's real response (verified against spec3.json's
 * `/telephony_credentials/{id}/token` POST, 201): `text/plain`, body is the raw JWT
 * string -- not JSON. `telnyxRequest` below JSON.parses every response and falls back to
 * `{ raw: text }` only when that throws, so callers of `mintCredentialToken` read the
 * token from `.raw`, not `.data`/`.token`.
 *
 * apiBase override (TASK-P2-E2): `createTelnyxClient(apiKey, { apiBase })` -- an explicit
 * constructor option, not a Deno.env read inside this file, so `deno test
 * supabase/functions/_shared` (RULES-CARD's bare command, no --allow-env) never needs env
 * permission to exercise it. Callers that want the env-driven `TELNYX_API_BASE` override read
 * it themselves (server-side, where env access is always available) and pass it through --
 * see `_shared/telnyx-org-context.ts`. This exists so TASK-P2-E2's `functions serve`
 * acceptance script can point a mock Telnyx HTTP server at it; production never sets the env
 * var, so every real caller gets the default.
 */

/** TASK-F-T3/BUG-7: widened from 'off'|'premium' -- the campaign-level modes this build now
 *  offers map 1:1 onto real CallRequest.answering_machine_detection enum members (verified
 *  against spec3.json, 2026-09-25: full enum is `premium|detect|detect_beep|detect_words|
 *  greeting_end|disabled`). See amdModeToTelnyxValue below for the exact mapping. */
export type AmdMode = 'off' | 'detect' | 'detect_words' | 'premium';

interface TelnyxEnvelope<T> {
  data?: T;
}

interface TelnyxCallData {
  call_control_id?: string;
  call_leg_id?: string;
  call_session_id?: string;
  id?: string;
}

interface TelnyxConferenceData {
  id?: string;
  name?: string;
}

interface TelnyxIdData {
  id?: string;
  [key: string]: unknown;
}

const DEFAULT_TELNYX_API_BASE = 'https://api.telnyx.com/v2';

async function telnyxRequest<T = unknown>(
  apiKey: string,
  apiBase: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errBody =
      typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed);
    if (res.status === 422 && (errBody.includes('webhook') || errBody.includes('Call Control'))) {
      throw new Error(
        `TELNYX_CONNECTION_REJECTED: ${errBody}. The connection ID must be a Call Control Application with a webhook URL, not a credential/SIP connection.`
      );
    }
    throw new Error(`Telnyx API ${method} ${path} failed (${res.status}): ${errBody}`);
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Pure payload builders — exported for `deno test` without a network call.
// ---------------------------------------------------------------------------

export interface DialArgs {
  connectionId: string;
  to: string;
  from: string;
  webhookUrl: string;
  clientState: string;
  /** Telnyx default is 30s, min 5, max 600 (CallRequest.timeout_secs). Contact dials pass 25s;
   *  the agent leg's own dial passes 45s (TASK-S1/BUG-8 -- see dialer-engine.ts's
   *  AGENT_DIAL_TIMEOUT_SECS for why it's longer). */
  timeoutSecs?: number;
  amdMode: AmdMode;
  /** CallRequest.time_limit_secs (verified against spec3.json, 2026-09-24 -- TASK-L1/BUG-8;
   *  re-verified 2026-09-25 -- TASK-S1): "Sets the maximum duration of a Call Control Leg in
   *  seconds... default AND max is 14400 (4h)." Every CONTACT dial passes 1800 (30min)
   *  explicitly -- a parallel-dial candidate leg should never run that long. The agent leg's
   *  own dial now ALSO passes this explicitly (14400, dialer-engine.ts's
   *  AGENT_DIAL_TIME_LIMIT_SECS) -- same as Telnyx's own default/max, but explicit so it can't
   *  silently drift if Telnyx ever changes it (TASK-S1/BUG-8). */
  timeLimitSecs?: number;
  /** CallRequest.custom_headers (verified against spec3.json): "Custom headers to be added
   *  to the SIP INVITE." This is how the agent leg's dial carries a session-identifying
   *  header through to the browser's incoming-call notification (TASK-L1) -- client_state
   *  round-trips through Telnyx's own webhooks/dialogParams either way, but a real SIP
   *  header is what the task spec asks for as the belt-and-suspenders signal. */
  customHeaders?: { name: string; value: string }[];
}

export interface TelnyxDialPayload {
  connection_id: string;
  to: string;
  from: string;
  webhook_url: string;
  client_state: string;
  timeout_secs: number;
  time_limit_secs?: number;
  custom_headers?: { name: string; value: string }[];
  answering_machine_detection: 'disabled' | 'detect' | 'detect_words' | 'premium';
  /** TASK-H19: premium only (spec3.json CallRequest.answering_machine_detection_config). */
  answering_machine_detection_config?: { total_analysis_time_millis: number };
}

/** A slow premium decision ends as not_sure (= claim) after this long, not Telnyx's own default.
 *  TASK-H32: 5000 -> 8000; business IVRs / hold queues were the most common not_sure and 5 s let
 *  too many voicemails through to agents. */
export const PREMIUM_AMD_TOTAL_ANALYSIS_MILLIS = 8000;

/** off -> 'disabled', every other value passes straight through -- all 4 are verified members
 *  of CallRequest.answering_machine_detection's enum (spec3.json). */
export function amdModeToTelnyxValue(
  mode: AmdMode
): 'disabled' | 'detect' | 'detect_words' | 'premium' {
  return mode === 'off' ? 'disabled' : mode;
}

export function buildDialPayload(args: DialArgs): TelnyxDialPayload {
  const payload: TelnyxDialPayload = {
    connection_id: args.connectionId,
    to: args.to,
    from: args.from,
    webhook_url: args.webhookUrl,
    client_state: args.clientState,
    timeout_secs: args.timeoutSecs ?? 25,
    answering_machine_detection: amdModeToTelnyxValue(args.amdMode),
  };
  if (args.amdMode === 'premium') {
    payload.answering_machine_detection_config = {
      total_analysis_time_millis: PREMIUM_AMD_TOTAL_ANALYSIS_MILLIS,
    };
  }
  if (args.timeLimitSecs !== undefined) payload.time_limit_secs = args.timeLimitSecs;
  if (args.customHeaders && args.customHeaders.length > 0) {
    payload.custom_headers = args.customHeaders;
  }
  return payload;
}

export interface AnswerArgs {
  /** AnswerRequest.client_state (spec3.json, verified for TASK-I1) -- tags every subsequent
   *  webhook on THIS SAME leg (call.answered, call.speak.ended, call.recording.saved/error via
   *  its own separate per-command client_state, ...). */
  clientState?: string;
}

export function buildAnswerPayload(args: AnswerArgs = {}): { client_state?: string } {
  const payload: { client_state?: string } = {};
  if (args.clientState) payload.client_state = args.clientState;
  return payload;
}

export interface TransferArgs {
  to: string;
  /** TransferCallRequest.from (spec3.json): "defaults to the `to` number of the original call
   *  if omitted" -- explicit here anyway (TASK-I1 always passes the caller-reached number, so
   *  the intern/cell/shared destination sees the SAME caller ID the public number itself has,
   *  never Telnyx's own default-guess). */
  from: string;
  /** Telnyx default 30s/min 5/max 600 (CallRequest.timeout_secs, same field re-verified on
   *  TransferCallRequest) -- TASK-I1 passes INBOUND_RING_TIMEOUT_SECS (20) explicitly. */
  timeoutSecs?: number;
  /** TransferCallRequest.target_leg_client_state: "add state to every subsequent webhook for
   *  the NEW leg" -- Leg B (the transfer destination) gets its OWN call_control_id, distinct
   *  from the original inbound leg's; this is how ITS webhooks correlate back to our
   *  inbound_calls row (see client-state.ts's InboundClientState header). */
  targetLegClientState?: string;
}

export function buildTransferPayload(args: TransferArgs): {
  to: string;
  from: string;
  timeout_secs?: number;
  target_leg_client_state?: string;
} {
  const payload: {
    to: string;
    from: string;
    timeout_secs?: number;
    target_leg_client_state?: string;
  } = { to: args.to, from: args.from };
  if (args.timeoutSecs !== undefined) payload.timeout_secs = args.timeoutSecs;
  if (args.targetLegClientState) payload.target_leg_client_state = args.targetLegClientState;
  return payload;
}

export interface RecordStartArgs {
  format?: 'mp3' | 'wav';
  channels: 'single' | 'dual';
  /** Base-64 string echoed back verbatim on this command's own resulting webhooks
   *  (call.recording.saved/call.recording.error) -- per-command, independent of the call's own
   *  dial-time client_state (StartRecordingRequest.client_state: "add state to every subsequent
   *  webhook"). TASK-F-T2 passes the same {org,session,leg} shape `dial()` uses
   *  (`encodeDialClientState`) so the recording webhook can map back to our row without relying
   *  on `call_control_id` -- verified against spec3.json that `call.recording.saved`'s payload
   *  carries none at all (only `call_leg_id`/`call_session_id`, both different UUIDs). */
  clientState?: string;
}

export function buildRecordStartPayload(args: RecordStartArgs): {
  format: 'mp3' | 'wav';
  channels: 'single' | 'dual';
  client_state?: string;
} {
  const payload: { format: 'mp3' | 'wav'; channels: 'single' | 'dual'; client_state?: string } = {
    format: args.format ?? 'mp3',
    channels: args.channels,
  };
  if (args.clientState) payload.client_state = args.clientState;
  return payload;
}

export interface PlaybackStartArgs {
  /** The signed URL Telnyx fetches the audio from (WAV or MP3) -- PlayAudioUrlRequest.audio_url,
   *  verified against spec3.json (TASK-F-T3/VMD-2). */
  audioUrl: string;
  /** PlayAudioUrlRequest.audio_type (default 'mp3' if omitted) -- declares the REAL format of
   *  the file at audioUrl regardless of any extension in the URL itself. Storage's signed URLs
   *  carry no reliable extension, and a stored .wav upload played back without this would let
   *  Telnyx default-assume mp3 and fail to decode it. */
  audioType?: 'mp3' | 'wav';
  /** Same per-command client_state shape as RecordStartArgs.clientState -- echoed back verbatim
   *  on this command's own call.playback.started/call.playback.ended webhooks. Not strictly
   *  needed for correlation (unlike recording's webhooks, call.playback.ended's real payload DOES
   *  carry call_control_id, verified against webhook-events.json) but kept for consistency with
   *  every other command this engine issues. */
  clientState?: string;
}

export function buildPlaybackStartPayload(args: PlaybackStartArgs): {
  audio_url: string;
  audio_type?: 'mp3' | 'wav';
  client_state?: string;
} {
  const payload: { audio_url: string; audio_type?: 'mp3' | 'wav'; client_state?: string } = {
    audio_url: args.audioUrl,
  };
  if (args.audioType) payload.audio_type = args.audioType;
  if (args.clientState) payload.client_state = args.clientState;
  return payload;
}

export interface TranscriptionStartArgs {
  /** Field name on the wire is `transcription_tracks`; default 'both' per design §5. */
  tracks?: 'inbound' | 'outbound' | 'both';
  engine?: 'Deepgram' | 'Google' | 'Telnyx';
}

export function buildTranscriptionStartPayload(args: TranscriptionStartArgs = {}): {
  transcription_engine: string;
  transcription_tracks: string;
} {
  return {
    transcription_engine: args.engine ?? 'Deepgram',
    transcription_tracks: args.tracks ?? 'both',
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** TASK-SP: `GET /balance`'s real fields (verified against spec3.json's `UserBalance` schema --
 *  `https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json`, 2026-09-25).
 *  Telnyx returns every amount as a decimal STRING ("300.00"), parsed to number here so callers
 *  never have to. */
export interface TelnyxBalance {
  balanceUsd: number;
  /** balance + credit_limit -- the actual amount that can still be spent. */
  availableCreditUsd: number;
  creditLimitUsd: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// TASK-BF1: add funds + auto-recharge (verified against spec3.json, 2026-09-25 --
// StoredPaymentTransactionRequest/Response, AutoRechargePref/AutoRechargePrefRequest). Every
// amount on the wire is a decimal STRING, same convention as getBalance's own fields above.
//
// NOTE the spec's own path literal for the charge endpoint is
// "/v2/payment/stored_payment_transactions" -- unlike every other path in the spec, it already
// embeds the /v2 this client's DEFAULT_TELNYX_API_BASE also ends in. `addFunds` below passes the
// DE-PREFIXED path to `req()`; passing the literal spec path straight through would double it
// (".../v2/v2/payment/..."), which the client-level test below asserts against.
// ---------------------------------------------------------------------------

export type AutoRechargePreference = 'credit_paypal' | 'ach';

export interface AutoRechargePrefs {
  id: string | null;
  enabled: boolean;
  thresholdAmountUsd: number;
  rechargeAmountUsd: number;
  invoiceEnabled: boolean;
  preference: AutoRechargePreference;
}

export interface UpdateAutoRechargePrefsArgs {
  enabled: boolean;
  thresholdAmountUsd: number;
  rechargeAmountUsd: number;
  invoiceEnabled: boolean;
  preference: AutoRechargePreference;
}

export interface AutoRechargePrefsPayload {
  enabled: boolean;
  threshold_amount: string;
  recharge_amount: string;
  invoice_enabled: boolean;
  preference: AutoRechargePreference;
}

export function buildAutoRechargePrefsPayload(
  args: UpdateAutoRechargePrefsArgs
): AutoRechargePrefsPayload {
  return {
    enabled: args.enabled,
    threshold_amount: args.thresholdAmountUsd.toFixed(2),
    recharge_amount: args.rechargeAmountUsd.toFixed(2),
    invoice_enabled: args.invoiceEnabled,
    preference: args.preference,
  };
}

export interface AddFundsResult {
  transactionId: string | null;
  amountCents: number | null;
  processorStatus: string | null;
}

/** StoredPaymentTransactionRequest's wire shape: `{amount: "120.00"}`. */
export function buildAddFundsPayload(amountUsd: number): { amount: string } {
  return { amount: amountUsd.toFixed(2) };
}

export interface TelnyxClient {
  getBalance(): Promise<TelnyxBalance>;

  /** TASK-BF1: `GET /payment/auto_recharge_prefs`. */
  getAutoRechargePrefs(): Promise<AutoRechargePrefs>;
  /** TASK-BF1: `PATCH /payment/auto_recharge_prefs`. */
  updateAutoRechargePrefs(args: UpdateAutoRechargePrefsArgs): Promise<AutoRechargePrefs>;
  /** TASK-BF1: `POST /payment/stored_payment_transactions` -- charges the org's own stored
   *  payment method on file. There is no Telnyx API to ADD a card; it's added once in the
   *  Telnyx portal, or this call 422s (see `mapTelnyxBillingError` in
   *  `_shared/billing-validation.ts`). Real money -- callers must validate the amount
   *  server-side and enforce idempotency/rate-limiting BEFORE calling this (see
   *  `telnyx-billing/index.ts`); this method itself never retries on failure. */
  addFunds(amountUsd: number): Promise<AddFundsResult>;

  dial(args: DialArgs): Promise<{ callControlId: string }>;
  hangup(callControlId: string): Promise<void>;
  /** TASK-I1: answers a PARKED inbound leg -- required before any other command on it besides
   *  transfer (spec3.json: "You must issue this command before executing subsequent commands
   *  on an incoming call"). Used for the voicemail sub-flow only; the intern/cell/shared
   *  fallback steps use `transfer` directly on the still-parked original leg instead. */
  answer(callControlId: string, args?: AnswerArgs): Promise<void>;
  /** TASK-I1: routes a call (answered OR still parked) to a new destination -- creates a
   *  brand-new Leg B with its own call_control_id/call.initiated. Verified against spec3.json:
   *  does NOT require the original leg to be answered first (its own webhook list starts with
   *  Leg B's `call.initiated`, and "the original call will remain active" on failure -- i.e.
   *  it was never itself answered/billed by this command). */
  transfer(callControlId: string, args: TransferArgs): Promise<void>;
  /**
   * TASK-L6: `GET /calls/{call_control_id}` -- verified against spec3.json's own
   * `RetrieveCallStatus` operation ("Retrieve a call status" / "Returns the status of a call
   * (data is available 10 minutes after call ended)."). Response schema (`Call`) requires
   * `is_alive: boolean` ("Indicates whether the call is alive or not."); no explicit 404 is
   * documented for an unknown/long-gone `call_control_id`, only a generic error response --
   * treated as a definitive "not alive" signal anyway (a call Telnyx has no record of at all
   * is at least as gone as one it reports `is_alive:false` for), same as this task's own
   * sweeper spec ("not-alive/404"). Returns `null` for anything else (any other HTTP error, or
   * a malformed/missing `is_alive`) -- the caller must never end a leg on an inconclusive
   * result, only on a definitive one.
   */
  getCallStatus(callControlId: string): Promise<{ isAlive: boolean } | null>;
  speak(callControlId: string, payload: { payload: string; voice: string }): Promise<void>;
  /** TASK-H11: `POST /calls/{id}/actions/send_dtmf` -- plays DTMF tones to the far end of the leg
   *  (an answering-machine menu: "press 1 to be connected"). `digits` is already validated by
   *  `_shared/dtmf.ts`. */
  sendDtmf(callControlId: string, digits: string): Promise<void>;

  createConference(args: {
    name: string;
    callControlId: string;
  }): Promise<{ id: string | null; name: string }>;
  joinConference(
    conferenceId: string,
    args: {
      callControlId: string;
      startConferenceOnEnter?: boolean;
      endConferenceOnExit?: boolean;
      /** TASK-T3: verified against spec3.json's `JoinConferenceRequest` -- "barge" enters as a
       *  normal participant (same as omitting this/"none"), "monitor" is muted-listen-only,
       *  "whisper" is heard only by `whisperCallControlIds`. Omitted for every existing caller
       *  (the agent leg, a contact winner leg) -- Telnyx defaults to "none" when absent, so this
       *  is purely additive. */
      supervisorRole?: 'barge' | 'monitor' | 'whisper';
      /** Required (per spec3.json) for `supervisorRole: 'whisper'` to have any effect --
       *  otherwise "the supervisor will join the conference as a monitoring participant only." */
      whisperCallControlIds?: string[];
    }
  ): Promise<void>;
  leaveConference(conferenceId: string, callControlId: string): Promise<void>;
  /**
   * TASK-T3: `POST /conferences/{id}/actions/update` -- verified against spec3.json's
   * `UpdateConferenceRequest`: switches an ALREADY-JOINED supervisor's role live (e.g. Listen ->
   * Whisper mid-call) without leaving and rejoining the conference. Distinct from
   * `/participants/{id}` PATCH (spec3.json's `UpdateConferenceParticipantRequest`), which has no
   * `supervisor_role` field at all -- only the `/actions/update` command can change it.
   * `supervisorRole: 'none'` demotes a supervisor back to a normal participant.
   */
  updateConferenceSupervisorRole(
    conferenceId: string,
    args: {
      callControlId: string;
      supervisorRole: 'barge' | 'monitor' | 'whisper' | 'none';
      whisperCallControlIds?: string[];
    }
  ): Promise<void>;
  /**
   * TASK-T4 (AUD-6 + warm/cold transfer): `POST /conferences/{id}/actions/hold` -- verified
   * against spec3.json's `ConferenceHoldRequest`. `callControlIds` is the SPECIFIC participant(s)
   * to hold -- everyone else in the same conference keeps talking normally (per-participant, not
   * conference-wide, per the schema's own "When empty all participants will be placed on hold"
   * wording -- we always pass a non-empty list, exactly the ones we mean to hold). `audioUrl` is
   * optional (Telnyx plays silence when omitted) -- no hold-music asset exists in this codebase
   * yet, disclosed in decisions.md rather than built out of scope tonight.
   */
  holdConferenceParticipants(
    conferenceId: string,
    args: { callControlIds: string[]; audioUrl?: string }
  ): Promise<void>;
  /**
   * TASK-T4: `POST /conferences/{id}/actions/unhold` -- verified against spec3.json's
   * `ConferenceUnholdRequest`, whose `call_control_ids` field is REQUIRED (unlike hold's own
   * optional-meaning-\"everyone\" list) -- there is no "unhold everyone" shorthand.
   */
  unholdConferenceParticipants(
    conferenceId: string,
    args: { callControlIds: string[] }
  ): Promise<void>;

  recordStart(callControlId: string, args: RecordStartArgs): Promise<void>;
  /**
   * MISSION-4 TASK-T8: `POST /calls/{id}/actions/record_pause` -- verified against spec3.json's
   * `PauseRecordingRequest`: every property (`client_state`/`command_id`/`recording_id`) is
   * OPTIONAL, so an empty body is a valid request; this lane only ever has one active recording
   * per call leg (`maybeStartRecording` calls `record_start` at most once per leg), so there is
   * no `recording_id` to disambiguate. No webhook is associated with this command (spec's own
   * words) -- the caller updates `call_legs` itself, synchronously, same as this file's own
   * `recordStart` callers already do for `recording_status`.
   */
  recordPause(callControlId: string): Promise<void>;
  /** MISSION-4 TASK-T8: `POST /calls/{id}/actions/record_resume` -- verified against spec3.json's
   *  `ResumeRecordingRequest`, same all-optional-properties shape as `PauseRecordingRequest`
   *  above, same "no associated webhook" note. */
  recordResume(callControlId: string): Promise<void>;
  transcriptionStart(callControlId: string, args?: TranscriptionStartArgs): Promise<void>;
  playbackStart(callControlId: string, args: PlaybackStartArgs): Promise<void>;

  searchNumbers(params: Record<string, string>): Promise<unknown>;
  orderNumber(args: { phoneNumbers: string[]; connectionId?: string }): Promise<TelnyxIdData>;
  updateNumber(phoneNumberId: string, args: Record<string, unknown>): Promise<TelnyxIdData>;

  createCallControlApplication(args: {
    applicationName: string;
    webhookEventUrl: string;
  }): Promise<TelnyxIdData>;
  getCallControlApplication(id: string): Promise<TelnyxIdData>;
  /** `PATCH /call_control_applications/{id}` with `outbound.outbound_voice_profile_id` --
   *  without a profile attached Telnyx refuses every outbound call from this application. */
  setCallControlApplicationOutboundProfile(id: string, profileId: string): Promise<void>;
  listCallControlApplications(): Promise<TelnyxIdData[]>;
  findCallControlApplicationByName(name: string): Promise<TelnyxIdData | null>;

  createOutboundVoiceProfile(args: { name: string }): Promise<TelnyxIdData>;
  findOutboundVoiceProfileByName(name: string): Promise<TelnyxIdData | null>;

  createCredentialConnection(args: {
    userName: string;
    password: string;
    connectionName: string;
  }): Promise<TelnyxIdData>;
  findCredentialConnectionByName(name: string): Promise<TelnyxIdData | null>;
  /** `PATCH /credential_connections/{id}` with `outbound.outbound_voice_profile_id` -- the
   *  browser's WebRTC (manual dial) calls leave Telnyx through this connection, and Telnyx
   *  refuses them outright when no outbound voice profile is attached. */
  setCredentialConnectionOutboundProfile(id: string, profileId: string): Promise<void>;

  createTelephonyCredential(args: { connectionId: string; name?: string }): Promise<TelnyxIdData>;
  getTelephonyCredential(id: string): Promise<TelnyxIdData>;
  listTelephonyCredentials(): Promise<TelnyxIdData[]>;
  findTelephonyCredentialByName(name: string): Promise<TelnyxIdData | null>;
  mintCredentialToken(credentialId: string): Promise<{ token: string | null }>;
}

export interface TelnyxClientOptions {
  /** Overrides the base URL (default `https://api.telnyx.com/v2`) -- see the header comment. */
  apiBase?: string;
}

export function createTelnyxClient(
  apiKey: string,
  options: TelnyxClientOptions = {}
): TelnyxClient {
  const apiBase = options.apiBase || DEFAULT_TELNYX_API_BASE;
  const req = <T>(path: string, init?: RequestInit) =>
    telnyxRequest<T>(apiKey, apiBase, path, init);

  return {
    async getBalance() {
      const response = await req<
        TelnyxEnvelope<{
          balance: string;
          available_credit: string;
          credit_limit: string;
          currency: string;
        }>
      >('/balance');
      const d = response.data;
      return {
        balanceUsd: Number(d?.balance ?? 0),
        availableCreditUsd: Number(d?.available_credit ?? 0),
        creditLimitUsd: Number(d?.credit_limit ?? 0),
        currency: d?.currency ?? 'USD',
      };
    },

    async dial(args) {
      const payload = buildDialPayload(args);
      const response = await req<TelnyxEnvelope<TelnyxCallData>>('/calls', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const callControlId = response.data?.call_control_id;
      if (!callControlId) throw new Error('Telnyx did not return call_control_id for dial');
      return { callControlId };
    },

    async hangup(callControlId) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    // Deliberately NOT built on `req`/`telnyxRequest` -- that helper throws on any non-2xx
    // status, losing the actual status code (needed to tell a definitive 404 apart from an
    // inconclusive 4xx/5xx). A raw fetch here keeps that distinction.
    async getCallStatus(callControlId) {
      // Review fix (minor 4): no timeout meant one hung GET could stall every LATER candidate
      // in the same sweeper invocation (cron ticks every 30s, so stalled invocations pile up).
      // AbortSignal.timeout rejects `fetch` itself once it fires; the caller's own
      // `.catch(() => null)` (dialer-sweeper-core.ts) already treats any rejection as
      // inconclusive -- never a false "not alive" -- so no new catch is needed here.
      const res = await fetch(`${apiBase}/calls/${encodeURIComponent(callControlId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404) return { isAlive: false };
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        data?: { is_alive?: boolean };
      } | null;
      if (typeof body?.data?.is_alive !== 'boolean') return null;
      return { isAlive: body.data.is_alive };
    },

    async speak(callControlId, payload) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async sendDtmf(callControlId, digits) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`, {
        method: 'POST',
        body: JSON.stringify({ digits }),
      });
    },

    async answer(callControlId, args) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
        method: 'POST',
        body: JSON.stringify(buildAnswerPayload(args)),
      });
    },

    async transfer(callControlId, args) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
        method: 'POST',
        body: JSON.stringify(buildTransferPayload(args)),
      });
    },

    async createConference(args) {
      // CreateConferenceRequest (verified against developers.telnyx.com's own
      // api-reference/conference-commands/create-conference.md and spec3.json, TASK-X2):
      // only `call_control_id` + `name` exist -- there is no `connection_id` field on this
      // request at all. Both are required; the docs' own words: "create a conference from
      // an existing call leg using call_control_id... the call will be automatically
      // bridged to the conference."
      const payload = {
        name: args.name,
        call_control_id: args.callControlId,
      };
      const response = await req<TelnyxEnvelope<TelnyxConferenceData>>('/conferences', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return {
        id: response.data?.id ?? null,
        name: response.data?.name ?? args.name,
      };
    },

    async joinConference(conferenceId, args) {
      // Verified: /calls/{id}/actions/join_conference does not exist in the current
      // Telnyx spec. Joining is a conference-side action: POST /conferences/{id}/actions/join.
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/join`, {
        method: 'POST',
        body: JSON.stringify({
          call_control_id: args.callControlId,
          start_conference_on_enter: args.startConferenceOnEnter ?? true,
          end_conference_on_exit: args.endConferenceOnExit ?? false,
          ...(args.supervisorRole ? { supervisor_role: args.supervisorRole } : {}),
          ...(args.whisperCallControlIds
            ? { whisper_call_control_ids: args.whisperCallControlIds }
            : {}),
        }),
      });
    },

    async leaveConference(conferenceId, callControlId) {
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/leave`, {
        method: 'POST',
        body: JSON.stringify({ call_control_id: callControlId }),
      });
    },

    async updateConferenceSupervisorRole(conferenceId, args) {
      // UpdateConferenceRequest (spec3.json): call_control_id + supervisor_role are both
      // required on this endpoint (unlike join, where supervisor_role is optional).
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/update`, {
        method: 'POST',
        body: JSON.stringify({
          call_control_id: args.callControlId,
          supervisor_role: args.supervisorRole,
          ...(args.whisperCallControlIds
            ? { whisper_call_control_ids: args.whisperCallControlIds }
            : {}),
        }),
      });
    },

    async holdConferenceParticipants(conferenceId, args) {
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/hold`, {
        method: 'POST',
        body: JSON.stringify({
          call_control_ids: args.callControlIds,
          ...(args.audioUrl ? { audio_url: args.audioUrl } : {}),
        }),
      });
    },

    async unholdConferenceParticipants(conferenceId, args) {
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/unhold`, {
        method: 'POST',
        body: JSON.stringify({ call_control_ids: args.callControlIds }),
      });
    },

    async recordStart(callControlId, args) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/record_start`, {
        method: 'POST',
        body: JSON.stringify(buildRecordStartPayload(args)),
      });
    },

    async recordPause(callControlId) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/record_pause`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    async recordResume(callControlId) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/record_resume`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    async transcriptionStart(callControlId, args = {}) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/transcription_start`, {
        method: 'POST',
        body: JSON.stringify(buildTranscriptionStartPayload(args)),
      });
    },

    async playbackStart(callControlId, args) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/playback_start`, {
        method: 'POST',
        body: JSON.stringify(buildPlaybackStartPayload(args)),
      });
    },

    async searchNumbers(params) {
      // /available_phone_numbers takes ONE deepObject `filter` query param (verified against
      // developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers.md
      // and spec3.json, TASK-X2): filter[country_code]=US&filter[best_effort]=true, not flat
      // country_code=US&best_effort=true -- Telnyx silently ignores unrecognized flat params,
      // so the old shape searched unfiltered against the real API.
      const filterParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        filterParams.set(`filter[${key}]`, value);
      }
      return req(`/available_phone_numbers?${filterParams.toString()}`);
    },

    async orderNumber(args) {
      // CreateNumberOrderRequest.phone_numbers is an array of {phone_number} OBJECTS, not
      // bare strings (verified against spec3.json, TASK-X2) -- a plain string array is
      // rejected by the real API.
      const payload: Record<string, unknown> = {
        phone_numbers: args.phoneNumbers.map((phoneNumber) => ({ phone_number: phoneNumber })),
      };
      if (args.connectionId) payload.connection_id = args.connectionId;
      const response = await req<TelnyxEnvelope<TelnyxIdData>>('/number_orders', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return response.data ?? {};
    },

    async updateNumber(phoneNumberId, args) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>(
        `/phone_numbers/${encodeURIComponent(phoneNumberId)}`,
        { method: 'PATCH', body: JSON.stringify(args) }
      );
      return response.data ?? {};
    },

    async createCallControlApplication(args) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>('/call_control_applications', {
        method: 'POST',
        body: JSON.stringify({
          application_name: args.applicationName,
          webhook_event_url: args.webhookEventUrl,
        }),
      });
      return response.data ?? {};
    },

    async getCallControlApplication(id) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>(
        `/call_control_applications/${encodeURIComponent(id)}`
      );
      return response.data ?? {};
    },

    async listCallControlApplications() {
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>('/call_control_applications');
      return response.data ?? [];
    },

    async findCallControlApplicationByName(name) {
      const qs = `filter[application_name][contains]=${encodeURIComponent(name)}`;
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>(
        `/call_control_applications?${qs}`
      );
      return (response.data ?? []).find((r) => r.application_name === name) ?? null;
    },

    async setCallControlApplicationOutboundProfile(id, profileId) {
      await req<unknown>(`/call_control_applications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ outbound: { outbound_voice_profile_id: profileId } }),
      });
    },

    async setCredentialConnectionOutboundProfile(id, profileId) {
      await req<unknown>(`/credential_connections/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ outbound: { outbound_voice_profile_id: profileId } }),
      });
    },

    async createOutboundVoiceProfile(args) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>('/outbound_voice_profiles', {
        method: 'POST',
        body: JSON.stringify({ name: args.name }),
      });
      return response.data ?? {};
    },

    async findOutboundVoiceProfileByName(name) {
      const qs = `filter[name][contains]=${encodeURIComponent(name)}`;
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>(`/outbound_voice_profiles?${qs}`);
      return (response.data ?? []).find((r) => r.name === name) ?? null;
    },

    async createCredentialConnection(args) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>('/credential_connections', {
        method: 'POST',
        body: JSON.stringify({
          user_name: args.userName,
          password: args.password,
          connection_name: args.connectionName,
          // Only calls originated from this Telnyx account may reach the org's WebRTC
          // credentials by SIP URI (the Call Control dial to the agent leg is one); the
          // default "disabled" may block that dial, and "unrestricted" would let anyone
          // ring an agent's browser.
          sip_uri_calling_preference: 'internal',
        }),
      });
      return response.data ?? {};
    },

    async findCredentialConnectionByName(name) {
      const qs = `filter[connection_name]=${encodeURIComponent(name)}`;
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>(`/credential_connections?${qs}`);
      return (response.data ?? []).find((r) => r.connection_name === name) ?? null;
    },

    async createTelephonyCredential(args) {
      const payload: Record<string, unknown> = { connection_id: args.connectionId };
      if (args.name) payload.name = args.name;
      const response = await req<TelnyxEnvelope<TelnyxIdData>>('/telephony_credentials', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return response.data ?? {};
    },

    async getTelephonyCredential(id) {
      const response = await req<TelnyxEnvelope<TelnyxIdData>>(
        `/telephony_credentials/${encodeURIComponent(id)}`
      );
      return response.data ?? {};
    },

    async listTelephonyCredentials() {
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>('/telephony_credentials');
      return response.data ?? [];
    },

    async findTelephonyCredentialByName(name) {
      const qs = `filter[name]=${encodeURIComponent(name)}`;
      const response = await req<TelnyxEnvelope<TelnyxIdData[]>>(`/telephony_credentials?${qs}`);
      return (response.data ?? []).find((r) => r.name === name) ?? null;
    },

    async mintCredentialToken(credentialId) {
      // 201 response is `text/plain` (a raw JWT), not JSON -- telnyxRequest's JSON.parse
      // throws on it and falls back to `{ raw: text }`. See this file's header.
      const response = await req<{ raw?: string }>(
        `/telephony_credentials/${encodeURIComponent(credentialId)}/token`,
        { method: 'POST' }
      );
      return { token: typeof response.raw === 'string' ? response.raw.trim() : null };
    },

    async getAutoRechargePrefs() {
      const response = await req<
        TelnyxEnvelope<{
          id?: string;
          threshold_amount?: string;
          recharge_amount?: string;
          enabled?: boolean;
          invoice_enabled?: boolean;
          preference?: AutoRechargePreference;
        }>
      >('/payment/auto_recharge_prefs');
      const d = response.data ?? {};
      return {
        id: d.id ?? null,
        enabled: d.enabled ?? false,
        thresholdAmountUsd: Number(d.threshold_amount ?? 0),
        rechargeAmountUsd: Number(d.recharge_amount ?? 0),
        invoiceEnabled: d.invoice_enabled ?? false,
        preference: d.preference ?? 'credit_paypal',
      };
    },

    async updateAutoRechargePrefs(args) {
      const payload = buildAutoRechargePrefsPayload(args);
      const response = await req<
        TelnyxEnvelope<{
          id?: string;
          threshold_amount?: string;
          recharge_amount?: string;
          enabled?: boolean;
          invoice_enabled?: boolean;
          preference?: AutoRechargePreference;
        }>
      >('/payment/auto_recharge_prefs', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const d = response.data ?? {};
      return {
        id: d.id ?? null,
        enabled: d.enabled ?? args.enabled,
        thresholdAmountUsd: Number(d.threshold_amount ?? args.thresholdAmountUsd),
        rechargeAmountUsd: Number(d.recharge_amount ?? args.rechargeAmountUsd),
        invoiceEnabled: d.invoice_enabled ?? args.invoiceEnabled,
        preference: d.preference ?? args.preference,
      };
    },

    async addFunds(amountUsd) {
      const payload = buildAddFundsPayload(amountUsd);
      // De-prefixed path -- see this file's TASK-BF1 header comment above (the spec's own path
      // literal already includes /v2, which apiBase also ends in).
      const response = await req<
        TelnyxEnvelope<{ id?: string; amount_cents?: number; processor_status?: string }>
      >('/payment/stored_payment_transactions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const d = response.data ?? {};
      return {
        transactionId: d.id ?? null,
        amountCents: d.amount_cents ?? null,
        processorStatus: d.processor_status ?? null,
      };
    },
  };
}

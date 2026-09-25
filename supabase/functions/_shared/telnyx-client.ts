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

export type AmdMode = 'off' | 'premium';

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
  /** Telnyx default is 30s, min 5, max 600 (CallRequest.timeout_secs). Design uses 25s. */
  timeoutSecs?: number;
  amdMode: AmdMode;
  /** CallRequest.time_limit_secs (verified against spec3.json, 2026-09-24 -- TASK-L1/BUG-8):
   *  "Sets the maximum duration of a Call Control Leg in seconds... default is 14400 (4h)."
   *  Every CONTACT dial passes 1800 (30min) explicitly -- the 4h default is sized for a
   *  human agent call, not a parallel-dial candidate leg that should never run that long.
   *  Omitted (agent leg dials) falls through to Telnyx's own 14400s default. */
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
  answering_machine_detection: 'disabled' | 'premium';
}

/** off -> 'disabled', premium -> 'premium' — both verified members of CallRequest.answering_machine_detection's enum. */
export function amdModeToTelnyxValue(mode: AmdMode): 'disabled' | 'premium' {
  return mode === 'premium' ? 'premium' : 'disabled';
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
  if (args.timeLimitSecs !== undefined) payload.time_limit_secs = args.timeLimitSecs;
  if (args.customHeaders && args.customHeaders.length > 0) {
    payload.custom_headers = args.customHeaders;
  }
  return payload;
}

export interface RecordStartArgs {
  format?: 'mp3' | 'wav';
  channels: 'single' | 'dual';
}

export function buildRecordStartPayload(args: RecordStartArgs): {
  format: 'mp3' | 'wav';
  channels: 'single' | 'dual';
} {
  return { format: args.format ?? 'mp3', channels: args.channels };
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

export interface TelnyxClient {
  getBalance(): Promise<unknown>;

  dial(args: DialArgs): Promise<{ callControlId: string }>;
  hangup(callControlId: string): Promise<void>;
  speak(callControlId: string, payload: { payload: string; voice: string }): Promise<void>;

  createConference(args: {
    name: string;
    callControlId: string;
  }): Promise<{ id: string | null; name: string }>;
  joinConference(
    conferenceId: string,
    args: { callControlId: string; startConferenceOnEnter?: boolean; endConferenceOnExit?: boolean }
  ): Promise<void>;
  leaveConference(conferenceId: string, callControlId: string): Promise<void>;

  recordStart(callControlId: string, args: RecordStartArgs): Promise<void>;
  transcriptionStart(callControlId: string, args?: TranscriptionStartArgs): Promise<void>;

  searchNumbers(params: Record<string, string>): Promise<unknown>;
  orderNumber(args: { phoneNumbers: string[]; connectionId?: string }): Promise<TelnyxIdData>;
  updateNumber(phoneNumberId: string, args: Record<string, unknown>): Promise<TelnyxIdData>;

  createCallControlApplication(args: {
    applicationName: string;
    webhookEventUrl: string;
  }): Promise<TelnyxIdData>;
  getCallControlApplication(id: string): Promise<TelnyxIdData>;
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
      return req<TelnyxEnvelope<unknown>>('/balance');
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

    async speak(callControlId, payload) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
        method: 'POST',
        body: JSON.stringify(payload),
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
        }),
      });
    },

    async leaveConference(conferenceId, callControlId) {
      await req(`/conferences/${encodeURIComponent(conferenceId)}/actions/leave`, {
        method: 'POST',
        body: JSON.stringify({ call_control_id: callControlId }),
      });
    },

    async recordStart(callControlId, args) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/record_start`, {
        method: 'POST',
        body: JSON.stringify(buildRecordStartPayload(args)),
      });
    },

    async transcriptionStart(callControlId, args = {}) {
      await req(`/calls/${encodeURIComponent(callControlId)}/actions/transcription_start`, {
        method: 'POST',
        body: JSON.stringify(buildTranscriptionStartPayload(args)),
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
  };
}

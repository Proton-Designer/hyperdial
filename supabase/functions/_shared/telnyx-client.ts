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

async function telnyxRequest<T = unknown>(
  apiKey: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
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
}

export interface TelnyxDialPayload {
  connection_id: string;
  to: string;
  from: string;
  webhook_url: string;
  client_state: string;
  timeout_secs: number;
  answering_machine_detection: 'disabled' | 'premium';
}

/** off -> 'disabled', premium -> 'premium' — both verified members of CallRequest.answering_machine_detection's enum. */
export function amdModeToTelnyxValue(mode: AmdMode): 'disabled' | 'premium' {
  return mode === 'premium' ? 'premium' : 'disabled';
}

export function buildDialPayload(args: DialArgs): TelnyxDialPayload {
  return {
    connection_id: args.connectionId,
    to: args.to,
    from: args.from,
    webhook_url: args.webhookUrl,
    client_state: args.clientState,
    timeout_secs: args.timeoutSecs ?? 25,
    answering_machine_detection: amdModeToTelnyxValue(args.amdMode),
  };
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
    connectionId: string;
    agentCallControlId?: string;
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
  mintCredentialToken(credentialId: string): Promise<unknown>;
}

export function createTelnyxClient(apiKey: string): TelnyxClient {
  const req = <T>(path: string, init?: RequestInit) => telnyxRequest<T>(apiKey, path, init);

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
      const payload: Record<string, string> = {
        name: args.name,
        connection_id: args.connectionId,
      };
      if (args.agentCallControlId) payload.call_control_id = args.agentCallControlId;
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
      const qs = new URLSearchParams(params).toString();
      return req(`/available_phone_numbers?${qs}`);
    },

    async orderNumber(args) {
      const payload: Record<string, unknown> = { phone_numbers: args.phoneNumbers };
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

    async mintCredentialToken(credentialId) {
      return req(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`, {
        method: 'POST',
      });
    },
  };
}

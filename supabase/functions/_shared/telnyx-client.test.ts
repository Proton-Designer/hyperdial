import { assertEquals } from 'jsr:@std/assert@1';
import {
  amdModeToTelnyxValue,
  buildAddFundsPayload,
  buildAnswerPayload,
  buildAutoRechargePrefsPayload,
  buildDialPayload,
  buildPlaybackStartPayload,
  buildRecordStartPayload,
  buildTranscriptionStartPayload,
  buildTransferPayload,
  createTelnyxClient,
} from './telnyx-client.ts';

// ---------------------------------------------------------------------------
// Pure builder tests — no network involved.
// ---------------------------------------------------------------------------

Deno.test('amdModeToTelnyxValue: off maps to disabled, every other mode passes through', () => {
  assertEquals(amdModeToTelnyxValue('off'), 'disabled');
  assertEquals(amdModeToTelnyxValue('detect'), 'detect');
  assertEquals(amdModeToTelnyxValue('detect_words'), 'detect_words');
  assertEquals(amdModeToTelnyxValue('premium'), 'premium');
});

Deno.test('buildDialPayload: includes required fields with the correct AMD mapping', () => {
  const payload = buildDialPayload({
    connectionId: 'conn-1',
    to: '+15551234567',
    from: '+15557654321',
    webhookUrl: 'https://example.com/telnyx-webhook?org=org-1',
    clientState: 'ZW5jb2RlZA==',
    amdMode: 'off',
  });
  assertEquals(payload, {
    connection_id: 'conn-1',
    to: '+15551234567',
    from: '+15557654321',
    webhook_url: 'https://example.com/telnyx-webhook?org=org-1',
    client_state: 'ZW5jb2RlZA==',
    timeout_secs: 25,
    answering_machine_detection: 'disabled',
  });
});

Deno.test('buildDialPayload: premium AMD and a custom timeout override the defaults', () => {
  const payload = buildDialPayload({
    connectionId: 'conn-1',
    to: '+15551234567',
    from: '+15557654321',
    webhookUrl: 'https://example.com/telnyx-webhook',
    clientState: 'ZW5jb2RlZA==',
    amdMode: 'premium',
    timeoutSecs: 20,
  });
  assertEquals(payload.answering_machine_detection, 'premium');
  assertEquals(payload.timeout_secs, 20);
  assertEquals(payload.answering_machine_detection_config, { total_analysis_time_millis: 5000 });
});

Deno.test('buildDialPayload: TASK-H19 -- AMD config is sent for premium only', () => {
  for (const amdMode of ['off', 'detect', 'detect_words'] as const) {
    const payload = buildDialPayload({
      connectionId: 'c',
      to: '+15551234567',
      from: '+15557654321',
      webhookUrl: 'https://example.com/w',
      clientState: 'x',
      amdMode,
    });
    assertEquals('answering_machine_detection_config' in payload, false);
  }
});

Deno.test(
  'buildDialPayload: TASK-L1/BUG-8 -- time_limit_secs and custom_headers are omitted when not supplied',
  () => {
    const payload = buildDialPayload({
      connectionId: 'conn-1',
      to: '+15551234567',
      from: '+15557654321',
      webhookUrl: 'https://example.com/telnyx-webhook',
      clientState: 'ZW5jb2RlZA==',
      amdMode: 'off',
    });
    assertEquals('time_limit_secs' in payload, false);
    assertEquals('custom_headers' in payload, false);
  }
);

Deno.test(
  'buildDialPayload: TASK-L1/BUG-8 -- every contact dial can carry time_limit_secs 1800 and custom_headers',
  () => {
    const payload = buildDialPayload({
      connectionId: 'conn-1',
      to: '+15551234567',
      from: '+15557654321',
      webhookUrl: 'https://example.com/telnyx-webhook',
      clientState: 'ZW5jb2RlZA==',
      amdMode: 'off',
      timeLimitSecs: 1800,
      customHeaders: [{ name: 'X-Hyperdial-Session', value: 'session-1' }],
    });
    assertEquals(payload.time_limit_secs, 1800);
    assertEquals(payload.custom_headers, [{ name: 'X-Hyperdial-Session', value: 'session-1' }]);
  }
);

Deno.test('buildRecordStartPayload: defaults to mp3, requires channels', () => {
  assertEquals(buildRecordStartPayload({ channels: 'dual' }), {
    format: 'mp3',
    channels: 'dual',
  });
  assertEquals(buildRecordStartPayload({ channels: 'single', format: 'wav' }), {
    format: 'wav',
    channels: 'single',
  });
});

Deno.test('buildRecordStartPayload: includes client_state only when provided', () => {
  assertEquals(buildRecordStartPayload({ channels: 'dual', clientState: 'abc123' }), {
    format: 'mp3',
    channels: 'dual',
    client_state: 'abc123',
  });
  assertEquals(Object.hasOwn(buildRecordStartPayload({ channels: 'dual' }), 'client_state'), false);
});

Deno.test('buildPlaybackStartPayload: audio_url required, client_state only when provided', () => {
  assertEquals(buildPlaybackStartPayload({ audioUrl: 'https://example.com/vm.mp3' }), {
    audio_url: 'https://example.com/vm.mp3',
  });
  assertEquals(
    buildPlaybackStartPayload({ audioUrl: 'https://example.com/vm.mp3', clientState: 'abc123' }),
    { audio_url: 'https://example.com/vm.mp3', client_state: 'abc123' }
  );
});

Deno.test('buildAnswerPayload: client_state only when provided', () => {
  assertEquals(buildAnswerPayload(), {});
  assertEquals(buildAnswerPayload({ clientState: 'c1' }), { client_state: 'c1' });
});

Deno.test(
  'buildTransferPayload: to/from always present, timeout_secs and target_leg_client_state only when provided',
  () => {
    assertEquals(buildTransferPayload({ to: 'sip:agent@sip.telnyx.com', from: '+15551234567' }), {
      to: 'sip:agent@sip.telnyx.com',
      from: '+15551234567',
    });
    assertEquals(
      buildTransferPayload({
        to: '+15559876543',
        from: '+15551234567',
        timeoutSecs: 20,
        targetLegClientState: 'c1',
      }),
      { to: '+15559876543', from: '+15551234567', timeout_secs: 20, target_leg_client_state: 'c1' }
    );
  }
);

Deno.test('buildTranscriptionStartPayload: defaults to Deepgram + both tracks', () => {
  assertEquals(buildTranscriptionStartPayload(), {
    transcription_engine: 'Deepgram',
    transcription_tracks: 'both',
  });
  assertEquals(buildTranscriptionStartPayload({ engine: 'Google', tracks: 'inbound' }), {
    transcription_engine: 'Google',
    transcription_tracks: 'inbound',
  });
});

// ---------------------------------------------------------------------------
// Client request-shape tests — fetch is stubbed, no real network call.
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test('createTelnyxClient: no apiBase option -> the real API', async () => {
  let seenUrl = '';
  const restore = stubFetch((url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  });
  try {
    await createTelnyxClient('test-api-key').getBalance();
    assertEquals(seenUrl, 'https://api.telnyx.com/v2/balance');
  } finally {
    restore();
  }
});

Deno.test(
  'createTelnyxClient: apiBase option redirects every request, an explicit constructor param (no env access, no special test flags)',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      await createTelnyxClient('test-api-key', {
        apiBase: 'http://localhost:9999/mock-telnyx',
      }).getBalance();
      assertEquals(seenUrl, 'http://localhost:9999/mock-telnyx/balance');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.dial: posts to /calls with the API key as a Bearer token',
  async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: { call_control_id: 'call-1' } }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const result = await client.dial({
        connectionId: 'conn-1',
        to: '+15551234567',
        from: '+15557654321',
        webhookUrl: 'https://example.com/telnyx-webhook',
        clientState: 'ZW5jb2RlZA==',
        amdMode: 'off',
      });
      assertEquals(result, { callControlId: 'call-1' });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls');
      assertEquals(seenAuth, 'Bearer test-api-key');
      assertEquals((seenBody as { connection_id: string }).connection_id, 'conn-1');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.dial: throws when Telnyx does not return a call_control_id',
  async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    try {
      const client = createTelnyxClient('test-api-key');
      let threw = false;
      try {
        await client.dial({
          connectionId: 'conn-1',
          to: '+15551234567',
          from: '+15557654321',
          webhookUrl: 'https://example.com/telnyx-webhook',
          clientState: 'ZW5jb2RlZA==',
          amdMode: 'off',
        });
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.answer: posts to /calls/{id}/actions/answer with client_state',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.answer('call-1', { clientState: 'c1' });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/answer');
      assertEquals(seenBody, { client_state: 'c1' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.transfer: posts to /calls/{id}/actions/transfer with to/from/timeout_secs/target_leg_client_state',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.transfer('call-1', {
        to: 'sip:agent-sip-user@sip.telnyx.com',
        from: '+15551234567',
        timeoutSecs: 20,
        targetLegClientState: 'c2',
      });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/transfer');
      assertEquals(seenBody, {
        to: 'sip:agent-sip-user@sip.telnyx.com',
        from: '+15551234567',
        timeout_secs: 20,
        target_leg_client_state: 'c2',
      });
    } finally {
      restore();
    }
  }
);

Deno.test('createTelnyxClient.getCallStatus: is_alive:true -> { isAlive: true }', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  const restore = stubFetch((url, init) => {
    seenUrl = url;
    seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    return new Response(JSON.stringify({ data: { is_alive: true } }), { status: 200 });
  });
  try {
    const result = await createTelnyxClient('test-api-key').getCallStatus('call-1');
    assertEquals(result, { isAlive: true });
    assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1');
    assertEquals(seenAuth, 'Bearer test-api-key');
  } finally {
    restore();
  }
});

Deno.test('createTelnyxClient.getCallStatus: is_alive:false -> { isAlive: false }', async () => {
  const restore = stubFetch(
    () => new Response(JSON.stringify({ data: { is_alive: false } }), { status: 200 })
  );
  try {
    const result = await createTelnyxClient('test-api-key').getCallStatus('call-1');
    assertEquals(result, { isAlive: false });
  } finally {
    restore();
  }
});

Deno.test(
  'createTelnyxClient.getCallStatus: 404 (unknown/long-gone call_control_id) is a DEFINITIVE not-alive signal',
  async () => {
    const restore = stubFetch(
      () => new Response(JSON.stringify({ errors: [{ detail: 'not found' }] }), { status: 404 })
    );
    try {
      const result = await createTelnyxClient('test-api-key').getCallStatus('call-1');
      assertEquals(result, { isAlive: false });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.getCallStatus: any other error status is inconclusive (null), never a false "not alive"',
  async () => {
    const restore = stubFetch(
      () => new Response(JSON.stringify({ errors: [{ detail: 'server error' }] }), { status: 500 })
    );
    try {
      const result = await createTelnyxClient('test-api-key').getCallStatus('call-1');
      assertEquals(result, null);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.getCallStatus: a malformed 200 (missing is_alive) is also inconclusive, not a crash',
  async () => {
    const restore = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    try {
      const result = await createTelnyxClient('test-api-key').getCallStatus('call-1');
      assertEquals(result, null);
    } finally {
      restore();
    }
  }
);

Deno.test(
  // TASK-T4 review fix-forward (BLOCKER 1, R-024): leaveConference had zero dedicated coverage
  // asserting its exact URL/body -- both cold and warm transfer completion depend on it moving
  // the prospect/agent between conferences correctly. Verified against LeaveConferenceRequest
  // (spec3.json:141280, required=[call_control_id] only) in api-evidence.md.
  'createTelnyxClient.leaveConference: hits /conferences/{id}/actions/leave with call_control_id',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.leaveConference('conf-1', 'call-1');
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences/conf-1/actions/leave');
      assertEquals(seenBody, { call_control_id: 'call-1' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  // TASK-T4 review fix-forward (BLOCKER 1, R-024): the only prior `hangup` coverage
  // (createTelnyxClient: a non-2xx response throws...) exercises the error path, never the
  // request itself. Verified against HangupRequest (spec3.json:136843, zero required fields).
  'createTelnyxClient.hangup: hits /calls/{id}/actions/hangup with an empty body',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.hangup('call-1');
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/hangup');
      assertEquals(seenBody, {});
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.joinConference: hits /conferences/{id}/actions/join, not /calls/.../join_conference',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.joinConference('conf-1', { callControlId: 'call-1' });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences/conf-1/actions/join');
      assertEquals((seenBody as { call_control_id: string }).call_control_id, 'call-1');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.joinConference: supervisorRole/whisperCallControlIds are only sent when provided (TASK-T3)',
  async () => {
    let seenBody: unknown = null;
    const restore = stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.joinConference('conf-1', {
        callControlId: 'call-mgr',
        supervisorRole: 'whisper',
        whisperCallControlIds: ['call-agent'],
      });
      assertEquals(seenBody, {
        call_control_id: 'call-mgr',
        start_conference_on_enter: true,
        end_conference_on_exit: false,
        supervisor_role: 'whisper',
        whisper_call_control_ids: ['call-agent'],
      });

      await client.joinConference('conf-1', { callControlId: 'call-agent-2' });
      assertEquals(seenBody, {
        call_control_id: 'call-agent-2',
        start_conference_on_enter: true,
        end_conference_on_exit: false,
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.updateConferenceSupervisorRole: hits /conferences/{id}/actions/update (TASK-T3)',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.updateConferenceSupervisorRole('conf-1', {
        callControlId: 'call-mgr',
        supervisorRole: 'barge',
      });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences/conf-1/actions/update');
      assertEquals(seenBody, { call_control_id: 'call-mgr', supervisor_role: 'barge' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.holdConferenceParticipants: hits /conferences/{id}/actions/hold with call_control_ids, audio_url omitted when not given (TASK-T4)',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.holdConferenceParticipants('conf-1', { callControlIds: ['call-prospect'] });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences/conf-1/actions/hold');
      assertEquals(seenBody, { call_control_ids: ['call-prospect'] });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.holdConferenceParticipants: audio_url is included when given',
  async () => {
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.holdConferenceParticipants('conf-1', {
        callControlIds: ['call-prospect'],
        audioUrl: 'https://example.com/hold.mp3',
      });
      assertEquals(seenBody, {
        call_control_ids: ['call-prospect'],
        audio_url: 'https://example.com/hold.mp3',
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.unholdConferenceParticipants: hits /conferences/{id}/actions/unhold with call_control_ids (TASK-T4)',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.unholdConferenceParticipants('conf-1', { callControlIds: ['call-prospect'] });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences/conf-1/actions/unhold');
      assertEquals(seenBody, { call_control_ids: ['call-prospect'] });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.playbackStart: hits /calls/{id}/actions/playback_start with audio_url',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.playbackStart('call-1', {
        audioUrl: 'https://example.com/vm.mp3',
        clientState: 'abc123',
      });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/playback_start');
      assertEquals(seenBody, { audio_url: 'https://example.com/vm.mp3', client_state: 'abc123' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.findOutboundVoiceProfileByName: filters by name[contains], matches only an exact name',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({
          data: [
            { id: 'ovp-other', name: 'hyperdial-org-abc-extra' },
            { id: 'ovp-1', name: 'hyperdial-org-abc' },
          ],
        }),
        { status: 200 }
      );
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const found = await client.findOutboundVoiceProfileByName('hyperdial-org-abc');
      assertEquals(
        seenUrl,
        'https://api.telnyx.com/v2/outbound_voice_profiles?filter[name][contains]=hyperdial-org-abc'
      );
      assertEquals(found, { id: 'ovp-1', name: 'hyperdial-org-abc' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.findOutboundVoiceProfileByName: no exact match among results returns null',
  async () => {
    const restore = stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: 'ovp-other', name: 'hyperdial-org-abc-extra' }] }),
          {
            status: 200,
          }
        )
    );
    try {
      const client = createTelnyxClient('test-api-key');
      const found = await client.findOutboundVoiceProfileByName('hyperdial-org-abc');
      assertEquals(found, null);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.findCallControlApplicationByName: filters by application_name[contains]',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ data: [{ id: 'app-1', application_name: 'hyperdial-org-abc' }] }),
        { status: 200 }
      );
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const found = await client.findCallControlApplicationByName('hyperdial-org-abc');
      assertEquals(
        seenUrl,
        'https://api.telnyx.com/v2/call_control_applications?filter[application_name][contains]=hyperdial-org-abc'
      );
      assertEquals(found, { id: 'app-1', application_name: 'hyperdial-org-abc' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.findCredentialConnectionByName: filters by the exact-match connection_name (no [contains])',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ data: [{ id: 'cred-1', connection_name: 'hyperdial-org-abc-webrtc' }] }),
        { status: 200 }
      );
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const found = await client.findCredentialConnectionByName('hyperdial-org-abc-webrtc');
      assertEquals(
        seenUrl,
        'https://api.telnyx.com/v2/credential_connections?filter[connection_name]=hyperdial-org-abc-webrtc'
      );
      assertEquals(found, { id: 'cred-1', connection_name: 'hyperdial-org-abc-webrtc' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.findTelephonyCredentialByName: filters by the consolidated filter[name]',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ data: [{ id: 'tc-1', name: 'hyperdial-member-org-1-user-1' }] }),
        { status: 200 }
      );
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const found = await client.findTelephonyCredentialByName('hyperdial-member-org-1-user-1');
      assertEquals(
        seenUrl,
        'https://api.telnyx.com/v2/telephony_credentials?filter[name]=hyperdial-member-org-1-user-1'
      );
      assertEquals(found, { id: 'tc-1', name: 'hyperdial-member-org-1-user-1' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.mintCredentialToken: parses a raw JWT text/plain response, not JSON',
  async () => {
    const restore = stubFetch(
      () => new Response('eyJhbGciOiJIUzUxMiJ9.fake.signature', { status: 201 })
    );
    try {
      const client = createTelnyxClient('test-api-key');
      const result = await client.mintCredentialToken('tc-1');
      assertEquals(result, { token: 'eyJhbGciOiJIUzUxMiJ9.fake.signature' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.createConference: posts call_control_id + name only (no connection_id, per CreateConferenceRequest)',
  async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: { id: 'conf-1', name: 'hyperdial-session-1' } }), {
        status: 200,
      });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      const result = await client.createConference({
        name: 'hyperdial-session-1',
        callControlId: 'call-1',
      });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/conferences');
      assertEquals(seenBody, { name: 'hyperdial-session-1', call_control_id: 'call-1' });
      assertEquals(result, { id: 'conf-1', name: 'hyperdial-session-1' });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.orderNumber: phone_numbers is an array of {phone_number} objects, not bare strings',
  async () => {
    let seenBody: Record<string, unknown> = {};
    const restore = stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: { id: 'order-1', phone_numbers: [] } }), {
        status: 200,
      });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.orderNumber({ phoneNumbers: ['+15551234567'], connectionId: 'conn-1' });
      assertEquals(seenBody, {
        phone_numbers: [{ phone_number: '+15551234567' }],
        connection_id: 'conn-1',
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.searchNumbers: wraps every filter key in filter[key] (deepObject style)',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.searchNumbers({
        country_code: 'US',
        national_destination_code: '212',
        best_effort: 'true',
      });
      assertEquals(
        seenUrl,
        'https://api.telnyx.com/v2/available_phone_numbers?' +
          'filter%5Bcountry_code%5D=US&filter%5Bnational_destination_code%5D=212&filter%5Bbest_effort%5D=true'
      );
    } finally {
      restore();
    }
  }
);

Deno.test('createTelnyxClient: a non-2xx response throws with the status and body', async () => {
  const restore = stubFetch(
    () => new Response(JSON.stringify({ errors: [{ detail: 'bad request' }] }), { status: 400 })
  );
  try {
    const client = createTelnyxClient('test-api-key');
    let message = '';
    try {
      await client.hangup('call-1');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertEquals(message.includes('400'), true);
    assertEquals(message.includes('bad request'), true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// TASK-BF1: add funds + auto-recharge
// ---------------------------------------------------------------------------

Deno.test(
  'buildAutoRechargePrefsPayload: amounts as 2-decimal strings, fields pass through',
  () => {
    assertEquals(
      buildAutoRechargePrefsPayload({
        enabled: true,
        thresholdAmountUsd: 20,
        rechargeAmountUsd: 104.5,
        invoiceEnabled: false,
        preference: 'credit_paypal',
      }),
      {
        enabled: true,
        threshold_amount: '20.00',
        recharge_amount: '104.50',
        invoice_enabled: false,
        preference: 'credit_paypal',
      }
    );
  }
);

Deno.test('buildAddFundsPayload: formats the amount to exactly 2 decimals', () => {
  assertEquals(buildAddFundsPayload(25), { amount: '25.00' });
  assertEquals(buildAddFundsPayload(104.5), { amount: '104.50' });
});

Deno.test(
  'createTelnyxClient.getAutoRechargePrefs: hits GET /payment/auto_recharge_prefs and parses the response',
  async () => {
    let seenUrl = '';
    let seenMethod = '';
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? 'GET';
      return new Response(
        JSON.stringify({
          data: {
            id: 'pref-1',
            threshold_amount: '20.00',
            recharge_amount: '100.00',
            enabled: true,
            invoice_enabled: false,
            preference: 'ach',
          },
        }),
        { status: 200 }
      );
    });
    try {
      const result = await createTelnyxClient('test-api-key').getAutoRechargePrefs();
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/payment/auto_recharge_prefs');
      assertEquals(seenMethod, 'GET');
      assertEquals(result, {
        id: 'pref-1',
        enabled: true,
        thresholdAmountUsd: 20,
        rechargeAmountUsd: 100,
        invoiceEnabled: false,
        preference: 'ach',
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.updateAutoRechargePrefs: PATCHes /payment/auto_recharge_prefs with the request payload',
  async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? 'GET';
      seenBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          data: {
            id: 'pref-1',
            threshold_amount: '15.00',
            recharge_amount: '50.00',
            enabled: true,
            invoice_enabled: true,
            preference: 'credit_paypal',
          },
        }),
        { status: 200 }
      );
    });
    try {
      const result = await createTelnyxClient('test-api-key').updateAutoRechargePrefs({
        enabled: true,
        thresholdAmountUsd: 15,
        rechargeAmountUsd: 50,
        invoiceEnabled: true,
        preference: 'credit_paypal',
      });
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/payment/auto_recharge_prefs');
      assertEquals(seenMethod, 'PATCH');
      assertEquals(JSON.parse(seenBody), {
        enabled: true,
        threshold_amount: '15.00',
        recharge_amount: '50.00',
        invoice_enabled: true,
        preference: 'credit_paypal',
      });
      assertEquals(result.thresholdAmountUsd, 15);
      assertEquals(result.rechargeAmountUsd, 50);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.addFunds: hits /payment/stored_payment_transactions, NOT /v2/payment/... (no doubled /v2)',
  async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? 'GET';
      seenBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          data: {
            id: 'txn-1',
            record_type: 'transaction',
            amount_cents: 2500,
            processor_status: 'succeeded',
            amount_currency: 'USD',
            auto_recharge: false,
            transaction_processing_type: 'stored_payment',
          },
        }),
        { status: 200 }
      );
    });
    try {
      const result = await createTelnyxClient('test-api-key').addFunds(25);
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/payment/stored_payment_transactions');
      assertEquals(seenUrl.includes('v2/v2'), false);
      assertEquals(seenMethod, 'POST');
      assertEquals(JSON.parse(seenBody), { amount: '25.00' });
      assertEquals(result, {
        transactionId: 'txn-1',
        amountCents: 2500,
        processorStatus: 'succeeded',
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.addFunds: a card-declined 422 throws with the status and detail intact',
  async () => {
    const restore = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ code: '40010', title: 'Payment declined', detail: 'card declined' }],
          }),
          { status: 422 }
        )
    );
    try {
      const client = createTelnyxClient('test-api-key');
      let message = '';
      try {
        await client.addFunds(25);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes('422'), true);
      assertEquals(message.includes('declined'), true);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.recordPause: hits /calls/{id}/actions/record_pause with an empty body',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.recordPause('call-1');
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/record_pause');
      assertEquals(seenBody, {});
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.recordResume: hits /calls/{id}/actions/record_resume with an empty body',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.recordResume('call-1');
      assertEquals(seenUrl, 'https://api.telnyx.com/v2/calls/call-1/actions/record_resume');
      assertEquals(seenBody, {});
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createTelnyxClient.set*OutboundProfile: PATCHes outbound.outbound_voice_profile_id on the application and the credential connection',
  async () => {
    const seen: { url: string; method?: string; body: Record<string, unknown> }[] = [];
    const restore = stubFetch((url, init) => {
      seen.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200 });
    });
    try {
      const client = createTelnyxClient('test-api-key');
      await client.setCallControlApplicationOutboundProfile('app-1', 'ovp-1');
      await client.setCredentialConnectionOutboundProfile('cred-1', 'ovp-1');
      assertEquals(seen, [
        {
          url: 'https://api.telnyx.com/v2/call_control_applications/app-1',
          method: 'PATCH',
          body: { outbound: { outbound_voice_profile_id: 'ovp-1' } },
        },
        {
          url: 'https://api.telnyx.com/v2/credential_connections/cred-1',
          method: 'PATCH',
          body: { outbound: { outbound_voice_profile_id: 'ovp-1' } },
        },
      ]);
    } finally {
      restore();
    }
  }
);

import { assertEquals } from 'jsr:@std/assert@1';
import {
  amdModeToTelnyxValue,
  buildDialPayload,
  buildRecordStartPayload,
  buildTranscriptionStartPayload,
  createTelnyxClient,
} from './telnyx-client.ts';

// ---------------------------------------------------------------------------
// Pure builder tests — no network involved.
// ---------------------------------------------------------------------------

Deno.test('amdModeToTelnyxValue: off maps to disabled, premium maps to premium', () => {
  assertEquals(amdModeToTelnyxValue('off'), 'disabled');
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

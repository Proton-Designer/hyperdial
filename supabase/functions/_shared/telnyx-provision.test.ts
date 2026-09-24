import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { TelnyxClient } from './telnyx-client.ts';
import { provisionTelnyxOrg, resourceNamesForOrg, webhookUrlForOrg } from './telnyx-provision.ts';

const ORG_ID = 'org-123';
const WEBHOOK_BASE = 'https://example.supabase.co/functions/v1/telnyx-webhook';

/** A mock TelnyxClient that records calls and returns fake ids, matching the shape a
 * real `createTelnyxClient` response would have (id-bearing objects, no envelope). */
function makeMockClient(overrides: Partial<TelnyxClient> = {}): {
  client: TelnyxClient;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });

  const client: TelnyxClient = {
    getBalance: async () => {
      record('getBalance', []);
      return { data: { balance: '10.00' } };
    },
    dial: async () => {
      throw new Error('not used in this test');
    },
    hangup: async () => {},
    speak: async () => {},
    createConference: async () => ({ id: null, name: '' }),
    joinConference: async () => {},
    leaveConference: async () => {},
    recordStart: async () => {},
    transcriptionStart: async () => {},
    searchNumbers: async () => ({}),
    orderNumber: async () => ({}),
    updateNumber: async () => ({}),
    createCallControlApplication: async (args) => {
      record('createCallControlApplication', [args]);
      return { id: 'app-1' };
    },
    getCallControlApplication: async () => ({}),
    listCallControlApplications: async () => [],
    createOutboundVoiceProfile: async (args) => {
      record('createOutboundVoiceProfile', [args]);
      return { id: 'ovp-1' };
    },
    createCredentialConnection: async (args) => {
      record('createCredentialConnection', [args]);
      return { id: 'cred-1' };
    },
    createTelephonyCredential: async () => ({}),
    getTelephonyCredential: async () => ({}),
    listTelephonyCredentials: async () => [],
    mintCredentialToken: async () => ({}),
    ...overrides,
  };

  return { client, calls };
}

Deno.test('resourceNamesForOrg / webhookUrlForOrg: stable, org-scoped names and URL', () => {
  assertEquals(resourceNamesForOrg(ORG_ID), {
    outboundVoiceProfile: 'softdial-org-org-123',
    callControlApplication: 'softdial-org-org-123',
    credentialConnection: 'softdial-org-org-123-webrtc',
  });
  assertEquals(
    webhookUrlForOrg(WEBHOOK_BASE, ORG_ID),
    'https://example.supabase.co/functions/v1/telnyx-webhook?org=org-123'
  );
});

Deno.test('provisionTelnyxOrg: first run creates all three resources', async () => {
  const { client, calls } = makeMockClient();
  const result = await provisionTelnyxOrg(client, { orgId: ORG_ID, webhookBaseUrl: WEBHOOK_BASE });

  assertEquals(result, {
    outboundVoiceProfileId: 'ovp-1',
    callControlApplicationId: 'app-1',
    credentialConnectionId: 'cred-1',
    created: {
      outboundVoiceProfile: true,
      callControlApplication: true,
      credentialConnection: true,
    },
  });

  const methodsCalled = calls.map((c) => c.method);
  assertEquals(methodsCalled, [
    'getBalance',
    'createOutboundVoiceProfile',
    'createCallControlApplication',
    'createCredentialConnection',
  ]);

  const appCall = calls.find((c) => c.method === 'createCallControlApplication');
  assertEquals(
    (appCall?.args[0] as { webhookEventUrl: string }).webhookEventUrl,
    'https://example.supabase.co/functions/v1/telnyx-webhook?org=org-123'
  );
});

Deno.test('provisionTelnyxOrg: second run with existing IDs creates nothing', async () => {
  const { client, calls } = makeMockClient();
  const result = await provisionTelnyxOrg(client, {
    orgId: ORG_ID,
    webhookBaseUrl: WEBHOOK_BASE,
    existing: {
      outboundVoiceProfileId: 'ovp-existing',
      callControlApplicationId: 'app-existing',
      credentialConnectionId: 'cred-existing',
    },
  });

  assertEquals(result, {
    outboundVoiceProfileId: 'ovp-existing',
    callControlApplicationId: 'app-existing',
    credentialConnectionId: 'cred-existing',
    created: {
      outboundVoiceProfile: false,
      callControlApplication: false,
      credentialConnection: false,
    },
  });
  assertEquals(
    calls.map((c) => c.method),
    ['getBalance']
  );
});

Deno.test(
  'provisionTelnyxOrg: reuses only the resources that already exist (partial state)',
  async () => {
    const { client, calls } = makeMockClient();
    const result = await provisionTelnyxOrg(client, {
      orgId: ORG_ID,
      webhookBaseUrl: WEBHOOK_BASE,
      existing: { outboundVoiceProfileId: 'ovp-existing' },
    });

    assertEquals(result.outboundVoiceProfileId, 'ovp-existing');
    assertEquals(result.callControlApplicationId, 'app-1');
    assertEquals(result.credentialConnectionId, 'cred-1');
    assertEquals(
      calls.map((c) => c.method),
      ['getBalance', 'createCallControlApplication', 'createCredentialConnection']
    );
  }
);

Deno.test(
  'provisionTelnyxOrg: an invalid key (getBalance rejects) aborts before creating anything',
  async () => {
    const { client, calls } = makeMockClient({
      getBalance: async () => {
        throw new Error('Telnyx API GET /balance failed (401): unauthorized');
      },
    });

    await assertRejects(() =>
      provisionTelnyxOrg(client, { orgId: ORG_ID, webhookBaseUrl: WEBHOOK_BASE })
    );
    assertEquals(calls.length, 0);
  }
);

Deno.test('provisionTelnyxOrg: throws if Telnyx returns no id for a created resource', async () => {
  const { client } = makeMockClient({
    createOutboundVoiceProfile: async () => ({}),
  });
  await assertRejects(
    () => provisionTelnyxOrg(client, { orgId: ORG_ID, webhookBaseUrl: WEBHOOK_BASE }),
    Error,
    'outbound voice profile'
  );
});

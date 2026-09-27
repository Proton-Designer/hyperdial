import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  credentialUserNameForOrg,
  provisionTelnyxOrg,
  resourceNamesForOrg,
  webhookUrlForOrg,
} from './telnyx-provision.ts';

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
      return { balanceUsd: 10, availableCreditUsd: 10, creditLimitUsd: 0, currency: 'USD' };
    },
    getAutoRechargePrefs: async () => ({
      id: null,
      enabled: false,
      thresholdAmountUsd: 0,
      rechargeAmountUsd: 0,
      invoiceEnabled: false,
      preference: 'credit_paypal',
    }),
    updateAutoRechargePrefs: async (args) => ({ id: null, ...args }),
    addFunds: async () => ({ transactionId: null, amountCents: null, processorStatus: null }),
    dial: async () => {
      throw new Error('not used in this test');
    },
    hangup: async () => {},
    getCallStatus: async () => null,
    speak: async () => {},
    answer: async () => {},
    transfer: async () => {},
    createConference: async () => ({ id: null, name: '' }),
    joinConference: async () => {},
    leaveConference: async () => {},
    updateConferenceSupervisorRole: async () => {},
    holdConferenceParticipants: async () => {},
    unholdConferenceParticipants: async () => {},
    recordStart: async () => {},
    recordPause: async () => {},
    recordResume: async () => {},
    transcriptionStart: async () => {},
    playbackStart: async () => {},
    searchNumbers: async () => ({}),
    orderNumber: async () => ({}),
    updateNumber: async () => ({}),
    createCallControlApplication: async (args) => {
      record('createCallControlApplication', [args]);
      return { id: 'app-1' };
    },
    getCallControlApplication: async () => ({}),
    listCallControlApplications: async () => [],
    findCallControlApplicationByName: async (name) => {
      record('findCallControlApplicationByName', [name]);
      return null;
    },
    createOutboundVoiceProfile: async (args) => {
      record('createOutboundVoiceProfile', [args]);
      return { id: 'ovp-1' };
    },
    findOutboundVoiceProfileByName: async (name) => {
      record('findOutboundVoiceProfileByName', [name]);
      return null;
    },
    createCredentialConnection: async (args) => {
      record('createCredentialConnection', [args]);
      return { id: 'cred-1' };
    },
    findCredentialConnectionByName: async (name) => {
      record('findCredentialConnectionByName', [name]);
      return null;
    },
    createTelephonyCredential: async () => ({}),
    getTelephonyCredential: async () => ({}),
    listTelephonyCredentials: async () => [],
    findTelephonyCredentialByName: async () => null,
    mintCredentialToken: async () => ({ token: null }),
    ...overrides,
  };

  return { client, calls };
}

Deno.test('resourceNamesForOrg / webhookUrlForOrg: stable, org-scoped names and URL', () => {
  assertEquals(resourceNamesForOrg(ORG_ID), {
    outboundVoiceProfile: 'hyperdial-org-org-123',
    callControlApplication: 'hyperdial-org-org-123',
    credentialConnection: 'hyperdial-org-org-123-webrtc',
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
    'findOutboundVoiceProfileByName',
    'createOutboundVoiceProfile',
    'findCallControlApplicationByName',
    'createCallControlApplication',
    'findCredentialConnectionByName',
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
      [
        'getBalance',
        'findCallControlApplicationByName',
        'createCallControlApplication',
        'findCredentialConnectionByName',
        'createCredentialConnection',
      ]
    );
  }
);

Deno.test(
  'provisionTelnyxOrg: retry after a failed persist (no stored IDs) reuses resources Telnyx already has by name, creates nothing',
  async () => {
    // Reproduces the scenario TASK-P1-05's eng1 review flagged: provisioning succeeds and
    // creates real Telnyx resources, but the write that would have persisted their IDs into
    // org_telephony fails, so a retry starts with `existing` empty again. Before this fix,
    // that retry could only create -- never find -- so it always duplicated. The mock here
    // simulates Telnyx already holding all three resources under their deterministic names.
    const names = resourceNamesForOrg(ORG_ID);
    const { client, calls } = makeMockClient({
      findOutboundVoiceProfileByName: async (name) => {
        calls.push({ method: 'findOutboundVoiceProfileByName', args: [name] });
        return name === names.outboundVoiceProfile ? { id: 'ovp-reused', name } : null;
      },
      findCallControlApplicationByName: async (name) => {
        calls.push({ method: 'findCallControlApplicationByName', args: [name] });
        return name === names.callControlApplication
          ? { id: 'app-reused', application_name: name }
          : null;
      },
      findCredentialConnectionByName: async (name) => {
        calls.push({ method: 'findCredentialConnectionByName', args: [name] });
        return name === names.credentialConnection
          ? { id: 'cred-reused', connection_name: name }
          : null;
      },
    });

    const result = await provisionTelnyxOrg(client, {
      orgId: ORG_ID,
      webhookBaseUrl: WEBHOOK_BASE,
      // Empty existing -- exactly what a fresh row (or one that never got its IDs written)
      // looks like on retry.
      existing: {},
    });

    assertEquals(result, {
      outboundVoiceProfileId: 'ovp-reused',
      callControlApplicationId: 'app-reused',
      credentialConnectionId: 'cred-reused',
      created: {
        outboundVoiceProfile: false,
        callControlApplication: false,
        credentialConnection: false,
      },
    });
    // No create* call anywhere in the trace -- everything was found, not duplicated.
    const methodsCalled = calls.map((c) => c.method);
    assertEquals(
      methodsCalled.some((m) => m.startsWith('create')),
      false
    );
  }
);

Deno.test(
  'provisionTelnyxOrg: find-by-name miss (nothing on Telnyx under that name either) still creates, exactly like a brand-new org',
  async () => {
    const { client, calls } = makeMockClient();
    const result = await provisionTelnyxOrg(client, {
      orgId: ORG_ID,
      webhookBaseUrl: WEBHOOK_BASE,
      existing: {},
    });
    assertEquals(result.created, {
      outboundVoiceProfile: true,
      callControlApplication: true,
      credentialConnection: true,
    });
    assertEquals(
      calls.map((c) => c.method),
      [
        'getBalance',
        'findOutboundVoiceProfileByName',
        'createOutboundVoiceProfile',
        'findCallControlApplicationByName',
        'createCallControlApplication',
        'findCredentialConnectionByName',
        'createCredentialConnection',
      ]
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

// Telnyx credential_connections.user_name: 4-32 chars, alphanumeric only, one of the first 5
// characters a letter. The rename-era `hyperdial_<hex>` (underscore, 42 chars) was rejected
// live with 422 code 10015 -- the positive control below proves this rule catches that shape.
const TELNYX_USER_NAME_OK = (s: string) =>
  /^[A-Za-z0-9]{4,32}$/.test(s) && /[A-Za-z]/.test(s.slice(0, 5));

Deno.test('credentialUserNameForOrg: satisfies Telnyx user_name rules', () => {
  const orgIds = [
    '4ff2cdd3-9ecc-4a84-b8ee-ba3f96ec8d5f',
    '00000000-0000-0000-0000-000000000000',
    '99999999-9999-4999-8999-999999999999',
  ];
  for (const orgId of orgIds) {
    const name = credentialUserNameForOrg(orgId);
    assertEquals(TELNYX_USER_NAME_OK(name), true, name);
  }
  assertEquals(credentialUserNameForOrg(orgIds[0]) === credentialUserNameForOrg(orgIds[1]), false);
});

Deno.test('credentialUserNameForOrg: positive control — the old shape fails the rule', () => {
  assertEquals(
    TELNYX_USER_NAME_OK(`hyperdial_${'4ff2cdd3-9ecc-4a84-b8ee-ba3f96ec8d5f'.replace(/-/g, '')}`),
    false
  );
});

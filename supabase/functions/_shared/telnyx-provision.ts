/**
 * Idempotent Telnyx resource provisioning for BYO-key orgs (design §3, "Connect
 * Telnyx"). Pure with respect to persistence: the caller (`telnyx-connect`) passes
 * in whatever resource IDs are already stored for the org, and this module only
 * creates what's missing — so a second run with the first run's output as `existing`
 * reuses everything and creates nothing. That's a deliberate simplification of the
 * design's "found by tag or name": we are the only writer of `org_telephony`, so our
 * own stored IDs are a reliable idempotency key without a Telnyx-side search. Logged
 * in `.brain/memory/decisions.md`.
 */

import type { TelnyxClient } from './telnyx-client.ts';

export interface ExistingTelnyxResources {
  outboundVoiceProfileId?: string | null;
  callControlApplicationId?: string | null;
  credentialConnectionId?: string | null;
}

export interface ProvisionedTelnyxResources {
  outboundVoiceProfileId: string;
  callControlApplicationId: string;
  credentialConnectionId: string;
  created: {
    outboundVoiceProfile: boolean;
    callControlApplication: boolean;
    credentialConnection: boolean;
  };
}

export interface ProvisionTelnyxOrgArgs {
  orgId: string;
  /** e.g. `https://<project>.supabase.co/functions/v1/telnyx-webhook` — no query string. */
  webhookBaseUrl: string;
  existing?: ExistingTelnyxResources;
}

export function resourceNamesForOrg(orgId: string): {
  outboundVoiceProfile: string;
  callControlApplication: string;
  credentialConnection: string;
} {
  return {
    outboundVoiceProfile: `softdial-org-${orgId}`,
    callControlApplication: `softdial-org-${orgId}`,
    credentialConnection: `softdial-org-${orgId}-webrtc`,
  };
}

export function webhookUrlForOrg(webhookBaseUrl: string, orgId: string): string {
  return `${webhookBaseUrl}?org=${encodeURIComponent(orgId)}`;
}

/**
 * Validates the key (`GET /v2/balance`) then finds-or-creates the outbound voice
 * profile, the Call Control Application (webhook URL tagged with `?org=<orgId>`)
 * and the credential connection, in that order — reusing any ID already present in
 * `args.existing`. Throws on the first missing id Telnyx doesn't return.
 */
export async function provisionTelnyxOrg(
  client: TelnyxClient,
  args: ProvisionTelnyxOrgArgs
): Promise<ProvisionedTelnyxResources> {
  await client.getBalance();

  const names = resourceNamesForOrg(args.orgId);
  const created = {
    outboundVoiceProfile: false,
    callControlApplication: false,
    credentialConnection: false,
  };

  let outboundVoiceProfileId = args.existing?.outboundVoiceProfileId ?? null;
  if (!outboundVoiceProfileId) {
    const ovp = await client.createOutboundVoiceProfile({ name: names.outboundVoiceProfile });
    outboundVoiceProfileId = typeof ovp.id === 'string' ? ovp.id : null;
    if (!outboundVoiceProfileId) {
      throw new Error('Telnyx did not return an id for the outbound voice profile');
    }
    created.outboundVoiceProfile = true;
  }

  let callControlApplicationId = args.existing?.callControlApplicationId ?? null;
  if (!callControlApplicationId) {
    const app = await client.createCallControlApplication({
      applicationName: names.callControlApplication,
      webhookEventUrl: webhookUrlForOrg(args.webhookBaseUrl, args.orgId),
    });
    callControlApplicationId = typeof app.id === 'string' ? app.id : null;
    if (!callControlApplicationId) {
      throw new Error('Telnyx did not return an id for the call control application');
    }
    created.callControlApplication = true;
  }

  let credentialConnectionId = args.existing?.credentialConnectionId ?? null;
  if (!credentialConnectionId) {
    const conn = await client.createCredentialConnection({
      userName: `softdial_${args.orgId.replace(/-/g, '')}`,
      password: crypto.randomUUID().replace(/-/g, ''),
      connectionName: names.credentialConnection,
    });
    credentialConnectionId = typeof conn.id === 'string' ? conn.id : null;
    if (!credentialConnectionId) {
      throw new Error('Telnyx did not return an id for the credential connection');
    }
    created.credentialConnection = true;
  }

  return { outboundVoiceProfileId, callControlApplicationId, credentialConnectionId, created };
}

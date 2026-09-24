/**
 * Idempotent Telnyx resource provisioning for BYO-key orgs (design §3, "Connect
 * Telnyx"). The caller (`telnyx-connect`) passes in whatever resource IDs are already
 * stored for the org; this module reuses any of those it has, and for everything else
 * falls back to a Telnyx-side find-by-name lookup (`find*ByName` on `TelnyxClient`)
 * before creating — so a retry with an empty `existing` (e.g. after a failed
 * `org_telephony` write, TASK-P1-05's eng1 review finding) still finds and reuses the
 * first run's real Telnyx resources instead of creating duplicates with the same
 * deterministic name. This replaces the original "IDs only" simplification recorded in
 * `.brain/memory/decisions.md` (2026-09-24) — that decision is superseded, not deleted,
 * since the name-based lookup this now performs is exactly the design's original
 * "found by tag or name" (§3), reinstated once the ID-only shortcut proved unsafe
 * across a failed-persist retry.
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
 * and the credential connection, in that order. For each resource: reuse the ID in
 * `args.existing` if present; otherwise look it up on Telnyx by its deterministic
 * name (`resourceNamesForOrg`) and reuse that if found; otherwise create it. Throws
 * on the first missing id Telnyx doesn't return.
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
    const found = await client.findOutboundVoiceProfileByName(names.outboundVoiceProfile);
    outboundVoiceProfileId = typeof found?.id === 'string' ? found.id : null;
  }
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
    const found = await client.findCallControlApplicationByName(names.callControlApplication);
    callControlApplicationId = typeof found?.id === 'string' ? found.id : null;
  }
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
    const found = await client.findCredentialConnectionByName(names.credentialConnection);
    credentialConnectionId = typeof found?.id === 'string' ? found.id : null;
  }
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

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

export interface NoDialNumber {
  error: string;
  code: 'NO_DIAL_NUMBER';
}

export const NO_NUMBER_MESSAGE =
  "You don't have a phone number yet. Ask your manager to assign you one in Settings, then try again.";
export const NUMBERS_CAPPED_MESSAGE =
  "All your numbers have hit today's dial limit or are resting. Try again later, or ask your manager for another number.";

/**
 * TASK-H23 F: a campaign with no fixed caller ID dials from the number pool. If the agent cannot get a pool number the
 * session used to start, answer the agent leg, then pause with 'no_numbers_available' at the first refill. Checked here
 * instead, before any agent leg exists. Same predicate as the refill (has_available_dial_number); the wording says whether
 * the agent has no number they could use (none) or has numbers that are all capped/resting (capped). Retired numbers never count.
 * Returns null when a number is available.
 */
export async function checkDialNumberAvailable(
  supabase: SupabaseAny,
  orgId: string,
  agentId: string
): Promise<NoDialNumber | null> {
  const { data: available, error } = await supabase.rpc('has_available_dial_number', {
    p_org_id: orgId,
    p_agent_id: agentId,
  });
  if (error) throw new Error(`has_available_dial_number: ${error.message}`);
  if (available) return null;
  const { count, error: countError } = await supabase
    .from('user_phone_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    // 'resting' counts: a number is set to resting the moment it reaches its cap, so a capped agent usually has none 'active'
    .in('status', ['active', 'resting'])
    .or(`assigned_user_id.is.null,assigned_user_id.eq.${agentId}`);
  if (countError) throw new Error(countError.message);
  return {
    error: count ? NUMBERS_CAPPED_MESSAGE : NO_NUMBER_MESSAGE,
    code: 'NO_DIAL_NUMBER',
  };
}

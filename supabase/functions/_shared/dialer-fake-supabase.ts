/**
 * The in-memory fake Supabase client (`.from()`/`.rpc()`) dialer-engine.test.ts was originally
 * built around, extracted into its own NON-test module so other test files (inbound-engine.
 * test.ts) can import it too. This deliberately does NOT end in `.test.ts`: `deno test` runs
 * each matched test file in its own isolated module registry, so importing a `.test.ts` file
 * from ANOTHER `.test.ts` file re-evaluates (and re-registers/re-runs) every `Deno.test()` call
 * in the imported file a second time under `deno test supabase/functions/_shared` (confirmed
 * empirically: dialer-engine.test.ts's own 28 tests ran twice once inbound-engine.test.ts
 * imported it directly). A plain shared module has no `Deno.test()` calls, so importing it from
 * multiple test files is exactly as free as it looks.
 *
 * Reimplements exactly the table shapes and RPC semantics dialer-engine.ts/inbound-engine.ts
 * actually call (claim_next_leads, claim_leg, transition_leg, transition_session,
 * apply_leg_outcome, record_webhook_event, get_org_telnyx_key, has_available_dial_number,
 * pick_and_reserve_dial_number, release_reserved_dial_number) -- no network, no DB, no Docker.
 */

interface Row {
  [key: string]: unknown;
}

export class FakeDb {
  tables = new Map<string, Map<string, Row>>();
  webhookEvents = new Set<string>();
  /** Every transition_session call, in order -- lets a test prove an intermediate state (e.g.
   *  'ready') was really reached even though the engine cascades past it synchronously within
   *  the same call. */
  sessionTransitions: { from: string; to: string }[] = [];

  table(name: string): Map<string, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  insert(table: string, row: Row): Row {
    const id = (row.id as string | undefined) ?? crypto.randomUUID();
    const full = { ...row, id };
    this.table(table).set(id, full);
    return full;
  }
}

function matchesFilters(
  row: Row,
  filters: [string, 'eq' | 'neq' | 'is' | 'in', unknown][]
): boolean {
  return filters.every(([col, op, val]) => {
    // A never-set fixture field is `undefined`, not `null` -- normalize for `.is()` so it
    // matches the same way a genuinely-NULL Postgres column would.
    if (op === 'is') return (row[col] ?? null) === val;
    if (op === 'eq') return row[col] === val;
    // TASK-T4 review fix-forward: cancelInFlightTransferForSession's own
    // `.in('status', ['dialing','connected'])` -- the first caller of `.in()` through this fake.
    if (op === 'in') return (val as unknown[]).includes(row[col]);
    return row[col] !== val;
  });
}

export class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private filters: [string, 'eq' | 'neq' | 'is' | 'in', unknown][] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] = {};
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private limitCount: number | null = null;
  private insertedRow: Row | null = null;
  private orderCol: string | null = null;
  private orderAscending = true;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(_cols?: string): this {
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.mode = 'delete';
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, 'eq', val]);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push([col, 'neq', val]);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push([col, 'in', vals]);
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push([col, 'is', val]);
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAscending = opts?.ascending ?? true;
    return this;
  }
  single(): this {
    this.singleMode = 'single';
    return this;
  }
  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  private execute(): { data: unknown; error: null } {
    if (this.mode === 'insert') {
      // MISSION-5 TASK-M5-B3 fix: a bulk `.insert([row, row, ...])` (notifyOwnersAndAdmins' own
      // established shape, e.g. reliability-alert-check/campaign-lines-guard-check) used to be
      // stored as ONE fake row whose value was the array itself (`db.insert` reads `row.id`,
      // which an array doesn't have, so it silently keyed the whole array under one random
      // uuid) -- any single-row `.insert(obj)` call elsewhere in this file was never affected,
      // only a genuinely bulk array payload was. Fixed to insert each element individually,
      // matching real Postgrest's own array-insert semantics.
      if (Array.isArray(this.payload)) {
        const inserted = this.payload.map((row) => this.db.insert(this.table, row));
        this.insertedRow = inserted[0] ?? null;
        return { data: inserted, error: null };
      }
      this.insertedRow = this.db.insert(this.table, this.payload);
      return { data: this.singleMode ? this.insertedRow : [this.insertedRow], error: null };
    }
    if (this.mode === 'update') {
      const rows = [...this.db.table(this.table).values()].filter((r) =>
        matchesFilters(r, this.filters)
      );
      for (const row of rows) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    if (this.mode === 'delete') {
      const table = this.db.table(this.table);
      const rows = [...table.values()].filter((r) => matchesFilters(r, this.filters));
      for (const row of rows) table.delete(row.id as string);
      return { data: null, error: null };
    }
    // select
    let rows = [...this.db.table(this.table).values()].filter((r) =>
      matchesFilters(r, this.filters)
    );
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAscending ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        return (av! > bv! ? 1 : -1) * dir;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.singleMode) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const FAKE_TELNYX_KEY = 'fake-telnyx-key';

/** Must track exactly the case-when arms in transition_session's real SQL definition
 *  (20260924000800_dialer_rpcs.sql + the 20260925005200 fix-forward for
 *  paused_agent_lost_from). See the M4 comment at this constant's one use site below. */
const TRANSITION_SESSION_FIELDS = [
  'agent_leg_id',
  'active_leg_id',
  'conference_id',
  'ended_at',
  'paused_agent_lost_from',
  'pause_reason',
  // MISSION-5 TASK-M5-N1 (20260927212609_call_takeover.sql, still unapplied): the same
  // allowlist-drift class this constant's own header warns about -- added here alongside the
  // fix-forward #2 dialer-engine.ts callers that now clear it.
  'taken_over_by_manager_id',
];

/** Same masking-bug class as TRANSITION_SESSION_FIELDS above (M4) -- transition_leg's fake used
 *  to be a blind `Object.assign`, which would have silently accepted a p_fields key the real
 *  SQL (20260924000800_dialer_rpcs.sql + 20260925020000's bridged_at/duration_seconds addition)
 *  doesn't write, exactly the way M4 went unnoticed. Must track that function's case-when arms
 *  exactly. */
const TRANSITION_LEG_FIELDS = [
  'outcome',
  'amd_result',
  'hangup_cause',
  'answered_at',
  'claimed_at',
  'bridged_at',
  'ended_at',
  'duration_seconds',
];

/** TASK-T4 review fix-forward: same allowlist-and-throw discipline as TRANSITION_LEG_FIELDS/
 *  TRANSITION_SESSION_FIELDS above, tracking transition_call_transfer's real SQL definition
 *  (20260926070002_transfer_hold.sql) exactly. */
const TRANSITION_CALL_TRANSFER_FIELDS = [
  'target_call_control_id',
  'side_conference_id',
  'ended_at',
  'ended_reason',
];

/** TASK-N1: UTC calendar day, matching the real SQL's `(now() at time zone 'utc')::date`. */
export function fakeToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function fakeDialsToday(db: FakeDb, numberId: string, today: string): number {
  const usage = db.table('number_daily_usage').get(`${numberId}|${today}`);
  return (usage?.dials as number | undefined) ?? 0;
}

function reactivateRestedNumbers(db: FakeDb, orgId: string): void {
  const now = Date.now();
  for (const n of db.table('user_phone_numbers').values()) {
    if (
      n.org_id === orgId &&
      n.status === 'resting' &&
      typeof n.resting_until === 'string' &&
      new Date(n.resting_until).getTime() <= now
    ) {
      n.status = 'active';
      n.resting_until = null;
    }
  }
}

function rpc(
  db: FakeDb,
  name: string,
  args: Record<string, unknown>
): { data: unknown; error: null } {
  switch (name) {
    case 'get_org_telnyx_key':
      return { data: FAKE_TELNYX_KEY, error: null };

    case 'record_webhook_event': {
      const eventId = args.p_event_id as string;
      if (db.webhookEvents.has(eventId)) return { data: false, error: null };
      db.webhookEvents.add(eventId);
      return { data: true, error: null };
    }

    case 'claim_next_leads': {
      const sessionId = args.p_session as string;
      const session = db.table('dial_sessions').get(sessionId);
      if (!session) return { data: [], error: null };
      // TASK-F-T3 (VMD-5): must track the real SQL's own capacity check exactly (see this
      // migration's own comment on that line) -- a leg playing a voicemail drop never holds up
      // a refill the way an 'ended' leg already doesn't.
      const activeContactLegs = [...db.table('call_legs').values()].filter(
        (l) =>
          l.session_id === sessionId &&
          l.kind === 'contact' &&
          l.state !== 'ended' &&
          l.state !== 'voicemail_dropping'
      ).length;
      const capacity = Math.max(0, (session.lines as number) - activeContactLegs);
      if (capacity === 0) return { data: [], error: null };
      const dueLeads = [...db.table('campaign_leads').values()]
        .filter((l) => l.campaign_id === session.campaign_id && l.status === 'queued')
        .sort((a, b) => (a.position as number) - (b.position as number))
        .slice(0, capacity);
      const results = dueLeads.map((lead) => {
        lead.status = 'in_flight';
        const contact = db.table('contacts').get(lead.contact_id as string)!;
        const legId = crypto.randomUUID();
        const callControlId = `pending-${crypto.randomUUID()}`;
        db.insert('call_legs', {
          id: legId,
          org_id: session.org_id,
          session_id: sessionId,
          campaign_id: session.campaign_id,
          contact_id: lead.contact_id,
          lead_id: lead.id,
          kind: 'contact',
          call_control_id: callControlId,
          state: 'initiated',
          outcome: null,
        });
        return {
          leg_id: legId,
          lead_id: lead.id,
          contact_id: lead.contact_id,
          phone_number: contact.phone_number,
          call_control_id: callControlId,
        };
      });
      return { data: results, error: null };
    }

    case 'claim_leg': {
      const session = db.table('dial_sessions').get(args.p_session as string);
      const leg = db.table('call_legs').get(args.p_leg as string);
      if (!session || !leg || session.state !== 'dialing' || session.active_leg_id) {
        return { data: false, error: null };
      }
      session.active_leg_id = leg.id;
      session.state = 'connecting';
      leg.state = 'claimed';
      leg.claimed_at = new Date().toISOString();
      return { data: true, error: null };
    }

    case 'transition_leg': {
      const callControlId = args.p_call_control_id as string;
      const expected = args.p_expected_states as string[];
      const leg = [...db.table('call_legs').values()].find(
        (l) => l.call_control_id === callControlId
      );
      if (!leg || !expected.includes(leg.state as string)) return { data: false, error: null };
      leg.state = args.p_new_state;
      const fields = (args.p_fields as Row | undefined) ?? {};
      for (const key of Object.keys(fields)) {
        if (!TRANSITION_LEG_FIELDS.includes(key)) {
          throw new Error(
            `fake transition_leg: unrecognized p_fields key '${key}' -- the real SQL function ` +
              `does not write it either; add it to both if that's intentional`
          );
        }
      }
      for (const key of TRANSITION_LEG_FIELDS) {
        if (key in fields) leg[key] = fields[key];
      }
      return { data: true, error: null };
    }

    case 'transition_call_transfer': {
      const transfer = db.table('call_transfers').get(args.p_transfer as string);
      const expected = args.p_expected_statuses as string[];
      if (
        !transfer ||
        transfer.org_id !== args.p_org ||
        !expected.includes(transfer.status as string)
      ) {
        return { data: false, error: null };
      }
      transfer.status = args.p_new_status;
      const fields = (args.p_fields as Row | undefined) ?? {};
      for (const key of Object.keys(fields)) {
        if (!TRANSITION_CALL_TRANSFER_FIELDS.includes(key)) {
          throw new Error(
            `fake transition_call_transfer: unrecognized p_fields key '${key}' -- the real SQL ` +
              `function does not write it either; add it to both if that's intentional`
          );
        }
      }
      for (const key of TRANSITION_CALL_TRANSFER_FIELDS) {
        if (key in fields) transfer[key] = fields[key];
      }
      return { data: true, error: null };
    }

    case 'transition_session': {
      const session = db.table('dial_sessions').get(args.p_session as string);
      const expected = args.p_expected_states as string[];
      if (!session || !expected.includes(session.state as string)) {
        return { data: false, error: null };
      }
      const from = session.state as string;
      const to = args.p_new_state as string;
      session.state = to;
      // Review fix (M4): the real SQL function (20260924000800 + the 20260925005200
      // fix-forward) only ever writes this exact allowlist of columns -- anything else in
      // p_fields is silently ignored by Postgres's `case when p_fields ? 'x' then ...`. The
      // old blind `Object.assign` here accepted ANY key, which is exactly how M4 (engine code
      // sending paused_agent_lost_from before the SQL function knew about it) went unnoticed
      // by every test in this file. Throwing on an unrecognized key means a future field added
      // to the engine's p_fields without a matching SQL migration + allowlist update fails a
      // test immediately instead of silently no-op'ing in prod.
      const fields = (args.p_fields as Row | undefined) ?? {};
      for (const key of Object.keys(fields)) {
        if (!TRANSITION_SESSION_FIELDS.includes(key)) {
          throw new Error(
            `fake transition_session: unrecognized p_fields key '${key}' -- the real SQL ` +
              `function does not write it either; add it to both if that's intentional`
          );
        }
      }
      for (const key of TRANSITION_SESSION_FIELDS) {
        if (key in fields) session[key] = fields[key];
      }
      db.sessionTransitions.push({ from, to });
      return { data: true, error: null };
    }

    case 'apply_leg_outcome': {
      // TASK-T4 review fix-forward: this used to also null out dial_sessions.active_leg_id when
      // the leg being finalized was the session's active one -- the REAL SQL function
      // (20260925050000_voicemail_drop.sql, apply_leg_outcome) never touches dial_sessions at
      // all, only call_legs.outcome_applied_at and campaign_leads. That extra mutation was this
      // fake's own inaccuracy (probably conflating it with transition_session's SEPARATE,
      // explicit active_leg_id clear, called elsewhere in dialer-engine.ts with its own
      // p_fields) -- harmless until a test needed session.active_leg_id to still equal the
      // just-ended leg's id AFTER apply_leg_outcome ran but BEFORE the caller's own later
      // transition_session call, which is exactly what processContactLegEvent's own
      // `currentLeg.id === session.active_leg_id` wrap_up check does. Fixed to match the real
      // function: a pure no-op against dial_sessions.
      const leg = db.table('call_legs').get(args.p_leg as string);
      if (!leg || leg.outcome == null) return { data: null, error: null };
      return { data: null, error: null };
    }

    // TASK-N1: both mirror private.reactivate_rested_numbers/has_available_dial_number's own
    // SQL exactly (20260925070000_number_pool.sql) -- same reactivation-then-check shape.
    case 'has_available_dial_number': {
      const orgId = args.p_org_id as string;
      const agentId = args.p_agent_id as string;
      reactivateRestedNumbers(db, orgId);
      const today = fakeToday();
      const available = [...db.table('user_phone_numbers').values()].some((n) => {
        if (n.org_id !== orgId || n.status !== 'active') return false;
        if (n.assigned_user_id != null && n.assigned_user_id !== agentId) return false;
        const dials = fakeDialsToday(db, n.id as string, today);
        return dials < (n.daily_cap as number);
      });
      return { data: available, error: null };
    }

    case 'pick_and_reserve_dial_number': {
      const orgId = args.p_org_id as string;
      const agentId = args.p_agent_id as string;
      const contactPhone = args.p_contact_phone as string;
      reactivateRestedNumbers(db, orgId);
      const today = fakeToday();
      const restDays =
        (db.table('org_number_pool_settings').get(orgId)?.rest_days as number | undefined) ?? 2;
      const areaCodeMatch = /^\+1\d{10}$/.test(contactPhone) ? contactPhone.slice(2, 5) : null;

      const candidates = [...db.table('user_phone_numbers').values()].filter((n) => {
        if (n.org_id !== orgId || n.status !== 'active') return false;
        if (n.assigned_user_id != null && n.assigned_user_id !== agentId) return false;
        const dials = fakeDialsToday(db, n.id as string, today);
        return dials < (n.daily_cap as number);
      });
      candidates.sort((a, b) => {
        const aAssigned = a.assigned_user_id === agentId ? 1 : 0;
        const bAssigned = b.assigned_user_id === agentId ? 1 : 0;
        if (aAssigned !== bAssigned) return bAssigned - aAssigned;
        const aAreaMatch =
          areaCodeMatch && (a.phone_number as string).slice(2, 5) === areaCodeMatch ? 1 : 0;
        const bAreaMatch =
          areaCodeMatch && (b.phone_number as string).slice(2, 5) === areaCodeMatch ? 1 : 0;
        if (aAreaMatch !== bAreaMatch) return bAreaMatch - aAreaMatch;
        return (
          fakeDialsToday(db, a.id as string, today) - fakeDialsToday(db, b.id as string, today)
        );
      });
      const chosen = candidates[0];
      if (!chosen) return { data: null, error: null };

      const usageId = `${chosen.id}|${today}`;
      const usage = db.table('number_daily_usage').get(usageId);
      const newDials = ((usage?.dials as number | undefined) ?? 0) + 1;
      if (usage) usage.dials = newDials;
      else
        db.insert('number_daily_usage', {
          id: usageId,
          number_id: chosen.id,
          org_id: orgId,
          day: today,
          dials: newDials,
        });

      if (newDials >= (chosen.daily_cap as number)) {
        chosen.status = 'resting';
        chosen.resting_until = new Date(Date.now() + restDays * 24 * 60 * 60 * 1000).toISOString();
      }
      return { data: chosen.id, error: null };
    }

    // TASK-N1 fix-forward (finding L): mirrors private.release_reserved_dial_number's SQL
    // exactly -- decrement (never below 0), reactivate only if that decrement is what drops it
    // back under cap.
    case 'release_reserved_dial_number': {
      const orgId = args.p_org_id as string;
      const numberId = args.p_number_id as string;
      const today = fakeToday();
      const usage = db.table('number_daily_usage').get(`${numberId}|${today}`);
      if (!usage) return { data: null, error: null };
      usage.dials = Math.max((usage.dials as number) - 1, 0);
      const number = db.table('user_phone_numbers').get(numberId);
      if (
        number &&
        number.org_id === orgId &&
        number.status === 'resting' &&
        (usage.dials as number) < (number.daily_cap as number)
      ) {
        number.status = 'active';
        number.resting_until = null;
      }
      return { data: null, error: null };
    }

    // MISSION-5 TASK-M5-B3: mirrors agent_daily_dial_status (20260927144500_distribution_
    // guards.sql) -- org_distribution_settings absent/disabled (the common case: no fixture
    // ever seeds it) returns cap_enabled: false, exactly like the real SQL's own
    // "v_enabled is null or not v_enabled" branch, so every pre-existing refillSession test
    // (none of which know this feature exists) sees zero behavior change.
    case 'agent_daily_dial_status': {
      const orgId = args.p_org as string;
      const agentId = args.p_agent as string;
      const settings = db.table('org_distribution_settings').get(orgId);
      const enabled = Boolean(settings?.daily_dial_cap_enabled);
      if (!enabled) {
        return {
          data: [{ cap_enabled: false, effective_cap: null, dialed_today: null }],
          error: null,
        };
      }
      const defaultCap = (settings!.daily_dial_cap_default as number | undefined) ?? 300;
      const override = db.table('org_agent_dial_caps').get(`${orgId}|${agentId}`);
      const effectiveCap = (override?.daily_cap as number | undefined) ?? defaultCap;
      const today = fakeToday();
      const dialedToday = [...db.table('call_legs').values()].filter((leg) => {
        if (leg.kind !== 'contact') return false;
        const session = db.table('dial_sessions').get(leg.session_id as string);
        if (!session || session.org_id !== orgId || session.agent_id !== agentId) return false;
        return typeof leg.created_at === 'string' && leg.created_at.slice(0, 10) === today;
      }).length;
      return {
        data: [{ cap_enabled: true, effective_cap: effectiveCap, dialed_today: dialedToday }],
        error: null,
      };
    }

    default:
      throw new Error(`fake rpc: unhandled function ${name}`);
  }
}

/** `extraRpc`, when given, is tried BEFORE the built-in switch above -- returning `undefined`
 *  falls through to it. Lets another test file (inbound-engine.test.ts) add its own RPC cases
 *  without this switch needing to know anything about them. */
export function createFakeSupabase(
  db: FakeDb,
  extraRpc?: (
    name: string,
    args: Record<string, unknown>
  ) => { data: unknown; error: null } | undefined
) {
  return {
    from(table: string) {
      return new FakeQuery(db, table);
    },
    rpc(name: string, args: Record<string, unknown>) {
      const extra = extraRpc?.(name, args);
      if (extra !== undefined) return Promise.resolve(extra);
      return Promise.resolve(rpc(db, name, args));
    },
    // TASK-F-T2: minimal fake of `.storage.from(bucket).upload()` -- the recording download
    // path's only Storage call. No error, no real bytes kept: the DB row update that follows
    // (recording_status/recording_path) is what the tests actually assert on.
    storage: {
      from(bucket: string) {
        return {
          upload(path: string, _body: unknown, _opts?: unknown) {
            return Promise.resolve({ data: { path }, error: null });
          },
          // TASK-F-T3: a minimal fake of `.storage.from(bucket).createSignedUrl()` -- the
          // voicemail playback path's only Storage call. No real signing; the returned URL just
          // encodes bucket/path/ttl so tests can assert the RIGHT file was signed.
          createSignedUrl(path: string, expiresIn: number) {
            return Promise.resolve({
              data: { signedUrl: `https://fake-storage.test/${bucket}/${path}?ttl=${expiresIn}` },
              error: null,
            });
          },
        };
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

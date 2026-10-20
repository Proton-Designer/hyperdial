import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildActiveIntervals,
  computeShiftKpi,
  earnedPowerWeek,
  isFinalizable,
  isConnect,
  mergeIntervals,
  powerIntervals,
  type KpiEvent,
  type KpiInput,
  type KpiLeg,
  type KpiWindow,
} from './shift-kpi-core.ts';
import { powerWeekSentence } from './shifts-core.ts';

const TZ = 'America/Chicago';
const SETTINGS = {
  timezone: TZ,
  grace_minutes: 10,
  idle_flag_minutes: 20,
  adherence_flag_pct: 75,
  conversation_min_seconds: 60,
  open_session_tail_minutes: 5,
};
const WINDOWS: KpiWindow[] = [
  { iso_weekdays: [1, 2, 3, 4, 5], start_time: '07:00:00', end_time: '10:00:00', active: true },
  { iso_weekdays: [1, 2, 3, 4, 5], start_time: '11:00:00', end_time: '14:00:00', active: true },
  { iso_weekdays: [1, 2, 3, 4, 5], start_time: '16:00:00', end_time: '18:00:00', active: false },
];
// Tue Oct 13 2026, 2:00-4:00 PM CDT
const SHIFT = {
  id: 's1',
  org_id: 'o',
  user_id: 'u',
  starts_at: '2026-10-13T19:00:00Z',
  ends_at: '2026-10-13T21:00:00Z',
};
const AFTER = Date.parse('2026-10-13T21:30:00Z');

const ev = (state: string, a: string, b: string | null, session = 'sess1'): KpiEvent => ({
  state,
  started_at: `2026-10-13T${a}:00Z`,
  ended_at: b === null ? null : `2026-10-13T${b}:00Z`,
  session_id: session,
});
const leg = (a: string, over: Partial<KpiLeg> = {}): KpiLeg => ({
  created_at: `2026-10-13T${a}:00Z`,
  ended_at: null,
  outcome: 'no_answer',
  amd_result: null,
  duration_seconds: 0,
  disposition: null,
  ...over,
});
/** A dial every `step` minutes between a and b (inclusive), each leg ending 30 s later. */
function dials(fromMin: number, toMin: number, step: number): KpiLeg[] {
  const out: KpiLeg[] = [];
  for (let m = fromMin; m <= toMin; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    out.push(leg(`${hh}:${mm}`, { ended_at: `2026-10-13T${hh}:${mm}:30Z` }));
  }
  return out;
}
const input = (over: Partial<KpiInput>): KpiInput => ({
  shift: SHIFT,
  settings: SETTINGS,
  windows: WINDOWS,
  events: [],
  legs: [],
  lastLegEnd: {},
  nowMs: AFTER,
  ...over,
});

Deno.test(
  'a fully active, steadily dialing shift: 120 active min, 100% adherence, no flags',
  () => {
    const k = computeShiftKpi(
      input({
        events: [ev('dialing', '18:55', '21:10')],
        legs: dials(19 * 60 + 2, 20 * 60 + 58, 4),
      })
    );
    assertEquals(k.scheduled_minutes, 120);
    assertEquals(k.active_dial_minutes, 120);
    assertEquals(k.adherence_pct, 100);
    assertEquals(k.flags, []);
    assertEquals(k.late_start_minutes, 2);
    assertEquals(k.dials, 30);
  }
);

Deno.test('a 20 minute pause drops active minutes by 20 and long_idle fires', () => {
  const k = computeShiftKpi(
    input({
      events: [
        ev('dialing', '19:00', '19:50'),
        ev('paused', '19:50', '20:10'),
        ev('on_call', '20:10', '21:00'),
      ],
      legs: [...dials(19 * 60 + 1, 19 * 60 + 49, 3), ...dials(20 * 60 + 12, 20 * 60 + 58, 3)],
    })
  );
  assertEquals(k.active_dial_minutes, 100);
  assertEquals(k.longest_idle_minutes >= 21, true);
  assertEquals(k.flags.includes('long_idle'), true);
  assertEquals(k.flags.includes('low_adherence'), false); // 83% >= 75
});

Deno.test(
  'browser closed mid-session: the unclosed interval ends at the last leg end + tail, not at the shift end',
  () => {
    const events = [ev('dialing', '19:00', null)];
    const lastLegEnd = { sess1: '2026-10-13T19:30:00Z' };
    const k = computeShiftKpi(
      input({ events, lastLegEnd, legs: dials(19 * 60 + 1, 19 * 60 + 29, 4) })
    );
    assertEquals(k.active_dial_minutes, 35);
    assertEquals(k.flags.includes('low_adherence'), true);
    assertEquals(k.flags.includes('left_early'), true); // last call ended 19:29:30, shift ends 21:00
    // no legs at all: start + tail
    const iv = buildActiveIntervals([ev('dialing', '19:00', null)], {}, 5, AFTER);
    assertEquals(iv, [[Date.parse('2026-10-13T19:00:00Z'), Date.parse('2026-10-13T19:05:00Z')]]);
    // still live and calling: capped by now, not by the tail
    const live = buildActiveIntervals(
      events,
      { sess1: '2026-10-13T19:59:00Z' },
      5,
      Date.parse('2026-10-13T20:00:00Z')
    );
    assertEquals(live, [[Date.parse('2026-10-13T19:00:00Z'), Date.parse('2026-10-13T20:00:00Z')]]);
  }
);

Deno.test('calls outside the shift window never count (before start, at/after end)', () => {
  const k = computeShiftKpi(
    input({
      events: [ev('dialing', '18:00', '22:00')],
      legs: [leg('18:50'), leg('19:10'), leg('20:59'), leg('21:00'), leg('21:05')],
    })
  );
  assertEquals(k.dials, 2);
  assertEquals(k.first_dial_at, '2026-10-13T19:10:00.000Z');
});

Deno.test(
  'zero dials -> no_show, only that flag; late start is the full shift; early end the full shift',
  () => {
    const k = computeShiftKpi(input({ events: [ev('dialing', '19:00', '19:20')] }));
    assertEquals(k.dials, 0);
    assertEquals(k.flags, ['no_show']);
    assertEquals(k.late_start_minutes, 120);
    assertEquals(k.early_end_minutes, 120);
    assertEquals(k.dials_per_active_hour, 0); // 20 active min, 0 dials
    assertEquals(k.connect_rate_pct, null);
  }
);

Deno.test(
  'connects, conversations, voicemails, no answers, talk minutes, dispositions (D6 definitions)',
  () => {
    const legs: KpiLeg[] = [
      leg('19:01', {
        outcome: 'connected',
        amd_result: 'human',
        duration_seconds: 300,
        disposition: 'Yes: profile build',
        ended_at: '2026-10-13T19:06:00Z',
      }),
      leg('19:10', {
        outcome: 'connected',
        amd_result: null,
        duration_seconds: 59,
        disposition: 'Not a fit',
      }),
      leg('19:20', { outcome: 'dropped', amd_result: 'human_business', duration_seconds: 120 }),
      leg('19:30', { outcome: 'machine', amd_result: 'machine' }),
      leg('19:40', { outcome: 'no_answer' }),
      leg('19:50', { outcome: 'busy', amd_result: 'silence' }),
      leg('20:00', {
        outcome: 'connected',
        amd_result: 'human',
        duration_seconds: 61,
        disposition: 'Not a fit',
      }),
    ];
    const k = computeShiftKpi(input({ events: [ev('dialing', '19:00', '21:00')], legs }));
    assertEquals(k.dials, 7);
    assertEquals(k.connects, 4);
    assertEquals(k.conversations, 3); // 300 s, 120 s, 61 s (59 s is below 60)
    assertEquals(k.voicemails, 1);
    assertEquals(k.no_answers, 1);
    assertEquals(k.talk_minutes, Math.round((300 + 59 + 120 + 61) / 60));
    assertEquals(k.dispositions, { 'Yes: profile build': 1, 'Not a fit': 2 });
    assertEquals(k.connect_rate_pct, 57.1);
    assertEquals(k.dials_per_active_hour, 3.5);
    assertEquals(isConnect({ outcome: 'busy', amd_result: 'not_sure' }), true);
    assertEquals(isConnect({ outcome: 'busy', amd_result: 'silence' }), false);
  }
);

Deno.test('power window clipping: only the active windows, per local date, DST-correct', () => {
  // Tue Oct 13 11:00-13:00 CDT = 16:00-18:00Z: Lunch (11-14) covers all of it
  const lunch = { ...SHIFT, starts_at: '2026-10-13T16:00:00Z', ends_at: '2026-10-13T18:00:00Z' };
  const k = computeShiftKpi(input({ shift: lunch, events: [ev('dialing', '15:00', '19:00')] }));
  assertEquals([k.active_dial_minutes, k.power_active_minutes], [120, 120]);
  // 9:00-11:00 CDT: only 9-10 is power (Morning); the inactive window never counts
  const mixed = { ...SHIFT, starts_at: '2026-10-13T14:00:00Z', ends_at: '2026-10-13T16:00:00Z' };
  const k2 = computeShiftKpi(input({ shift: mixed, events: [ev('dialing', '13:00', '17:00')] }));
  assertEquals(k2.power_active_minutes, 60);
  // 4-6 PM window is inactive
  const pm = { ...SHIFT, starts_at: '2026-10-13T21:00:00Z', ends_at: '2026-10-13T23:00:00Z' };
  assertEquals(
    computeShiftKpi(
      input({
        shift: pm,
        events: [ev('dialing', '20:00', '23:30')],
        nowMs: Date.parse('2026-10-14T00:00:00Z'),
      })
    ).power_active_minutes,
    0
  );
  // DST: Mon Oct 26 07:00 CDT = 12:00Z; Mon Nov 2 07:00 CST = 13:00Z. A Morning shift is all power both weeks.
  for (const [s, e] of [
    ['2026-10-26T12:00:00Z', '2026-10-26T15:00:00Z'],
    ['2026-11-02T13:00:00Z', '2026-11-02T16:00:00Z'],
  ]) {
    const iv = powerIntervals(WINDOWS, TZ, Date.parse(s), Date.parse(e));
    assertEquals(iv, [[Date.parse(s), Date.parse(e)]]);
  }
  // an interval pair that touches is merged
  assertEquals(
    mergeIntervals([
      [0, 5],
      [5, 9],
      [20, 25],
    ]),
    [
      [0, 9],
      [20, 25],
    ]
  );
});

Deno.test(
  'a shift still running is measured so far: no no_show / left_early / low_adherence yet',
  () => {
    const now = Date.parse('2026-10-13T20:00:00Z'); // an hour in
    const k = computeShiftKpi(
      input({
        nowMs: now,
        events: [ev('dialing', '19:00', null)],
        lastLegEnd: { sess1: '2026-10-13T19:59:30Z' },
        legs: dials(19 * 60 + 1, 19 * 60 + 59, 3),
      })
    );
    assertEquals(k.active_dial_minutes, 60);
    assertEquals(k.scheduled_minutes, 120);
    assertEquals(k.flags, []);
    assertEquals(k.early_end_minutes, 0);
    // an hour in with no dial yet: late start shows, but not no_show
    const none = computeShiftKpi(input({ nowMs: now, events: [ev('dialing', '19:00', null)] }));
    assertEquals(none.flags, ['late_start', 'long_idle']);
  }
);

Deno.test('late start / left early thresholds use grace (strictly greater)', () => {
  const base = { events: [ev('dialing', '19:00', '21:00')] };
  const on = computeShiftKpi(
    input({
      ...base,
      legs: [
        ...dials(19 * 60 + 10, 19 * 60 + 12, 1),
        ...dials(20 * 60 + 20, 20 * 60 + 28, 4),
        ...dials(20 * 60 + 30, 20 * 60 + 50, 4),
      ],
    })
  );
  assertEquals(on.late_start_minutes, 10);
  assertEquals(on.flags.includes('late_start'), false); // 10 is not > 10
  const late = computeShiftKpi(input({ ...base, legs: dials(19 * 60 + 11, 19 * 60 + 59, 5) }));
  assertEquals(late.flags.includes('late_start'), true);
  assertEquals(late.flags.includes('left_early'), true);
});

Deno.test(
  'Power week: 10 h all in power -> "all in power windows"; 88% earns it; 79% does not and says nothing negative',
  () => {
    const ten = earnedPowerWeek({
      powerMinutes: 600,
      activeMinutes: 600,
      powerWeekPct: 80,
      countedHours: 10,
      minimumHours: 8,
    });
    assertEquals(ten, { pct: 100, earned: true });
    assertEquals(
      powerWeekSentence('Sara K.', 600, ten.pct ?? 0),
      'Sara K. dialed 10.0 hrs this week, all in power windows.'
    );
    const omar = earnedPowerWeek({
      powerMinutes: 450,
      activeMinutes: 510,
      powerWeekPct: 80,
      countedHours: 8.5,
      minimumHours: 8,
    });
    assertEquals(omar, { pct: 88.2, earned: true });
    assertEquals(
      powerWeekSentence('Omar B.', 510, omar.pct ?? 0),
      'Omar B. dialed 8.5 hrs this week, 88% in power windows.'
    );
    const short = earnedPowerWeek({
      powerMinutes: 79,
      activeMinutes: 100,
      powerWeekPct: 80,
      countedHours: 9,
      minimumHours: 8,
    });
    assertEquals(short, { pct: 79, earned: false });
    // under an hour dialed, or minimum not met, or nothing dialed: not earned
    assertEquals(
      earnedPowerWeek({
        powerMinutes: 50,
        activeMinutes: 50,
        powerWeekPct: 80,
        countedHours: 9,
        minimumHours: 8,
      }).earned,
      false
    );
    assertEquals(
      earnedPowerWeek({
        powerMinutes: 600,
        activeMinutes: 600,
        powerWeekPct: 80,
        countedHours: 7,
        minimumHours: 8,
      }).earned,
      false
    );
    assertEquals(
      earnedPowerWeek({
        powerMinutes: 0,
        activeMinutes: 0,
        powerWeekPct: 80,
        countedHours: 9,
        minimumHours: 8,
      }),
      { pct: null, earned: false }
    );
  }
);

Deno.test('finalize only after 2 hours past the end', () => {
  const end = '2026-10-13T21:00:00Z';
  assertEquals(isFinalizable(end, Date.parse('2026-10-13T22:59:00Z')), false);
  assertEquals(isFinalizable(end, Date.parse('2026-10-13T23:01:00Z')), true);
});

Deno.test(
  'S05F: a leg with no ended_at ends at min(now, created + 30 min), never at "now" for ever',
  () => {
    // created 19:30Z, never ended, evaluated at 21:30Z: ends 20:00Z, so the idle gap to the shift end (21:00Z) is 60 min
    const stale = computeShiftKpi(
      input({ events: [ev('dialing', '19:00', '21:00')], legs: [leg('19:30')] })
    );
    assertEquals(stale.last_call_end_at, '2026-10-13T20:00:00.000Z');
    assertEquals(stale.longest_idle_minutes, 60);
    // created 20:50Z, still running at 20:55Z: it counts as "now" (20:55Z)
    const running = computeShiftKpi(
      input({
        events: [ev('dialing', '19:00', null)],
        legs: [leg('20:50')],
        nowMs: Date.parse('2026-10-13T20:55:00Z'),
      })
    );
    assertEquals(running.last_call_end_at, '2026-10-13T20:55:00.000Z');
  }
);

Deno.test('S05F: a failed placeholder leg counts as a dial, like call_leg_analytics', () => {
  const k = computeShiftKpi(
    input({
      events: [ev('dialing', '19:00', '21:00')],
      legs: [
        leg('19:05', { outcome: 'failed', ended_at: '2026-10-13T19:05:01Z' }),
        leg('19:06', {
          outcome: 'connected',
          duration_seconds: 90,
          ended_at: '2026-10-13T19:08:00Z',
        }),
      ],
    })
  );
  assertEquals(k.dials, 2);
  assertEquals(k.connects, 1);
  assertEquals(k.connect_rate_pct, 50);
});

Deno.test(
  'G01: sign_ups counts legs whose disposition is a win; conversion = sign_ups / conversations',
  () => {
    const legs: KpiLeg[] = [
      leg('19:01', {
        outcome: 'connected',
        duration_seconds: 300,
        disposition: 'Yes',
        is_win: true,
      }),
      leg('19:10', {
        outcome: 'connected',
        duration_seconds: 120,
        disposition: 'No',
        is_win: false,
      }),
      leg('19:20', { outcome: 'connected', duration_seconds: 90 }), // is_win absent -> not a sign-up
      leg('19:30', { outcome: 'no_answer' }),
    ];
    const k = computeShiftKpi(input({ events: [ev('dialing', '19:00', '21:00')], legs }));
    assertEquals(k.conversations, 3);
    assertEquals(k.sign_ups, 1);
    assertEquals(k.conversion_rate_pct, 33.3);
  }
);

Deno.test('G01: no conversations -> conversion rate is null; zero sign_ups is 0', () => {
  const legs: KpiLeg[] = [leg('19:01', { outcome: 'no_answer' })];
  const k = computeShiftKpi(input({ events: [ev('dialing', '19:00', '21:00')], legs }));
  assertEquals(k.sign_ups, 0);
  assertEquals(k.conversion_rate_pct, null);
});

Deno.test(
  'G01: a win on a connect shorter than the conversation threshold counts as a sign-up, conversion stays null',
  () => {
    const legs: KpiLeg[] = [
      leg('19:01', {
        outcome: 'connected',
        duration_seconds: 20,
        disposition: 'Yes',
        is_win: true,
      }),
    ];
    const k = computeShiftKpi(input({ events: [ev('dialing', '19:00', '21:00')], legs }));
    assertEquals(k.conversations, 0);
    assertEquals(k.sign_ups, 1);
    assertEquals(k.conversion_rate_pct, null);
  }
);

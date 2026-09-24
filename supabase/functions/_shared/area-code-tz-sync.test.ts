/**
 * Three copies of the same area-code -> timezone table exist by necessity (LANE-eng1.md,
 * TASK-P2-P1): `_shared/area-code-tz.ts` (Deno), `apps/web/src/lib/area-code-tz.ts` (browser,
 * Vite can't resolve the Deno `npm:` specifier), and `private.area_code_timezones`'s seed rows
 * in `20260924001300_contacts_e164_tz_dnc.sql` (SQL can't import either TS file). Nothing
 * enforces they stay identical -- this test does. Needs `--allow-read` (only to read the
 * migration file's text; both TS copies are plain module imports, which don't need it) --
 * `deno test --allow-read supabase/functions/_shared`, not the fully bare command.
 */
import { AREA_CODE_TIMEZONES as SHARED } from './area-code-tz.ts';
import { AREA_CODE_TIMEZONES as WEB } from '../../../apps/web/src/lib/area-code-tz.ts';

const MIGRATION_PATH = new URL(
  '../../migrations/20260924001300_contacts_e164_tz_dnc.sql',
  import.meta.url
);

/** Parses `insert into private.area_code_timezones (area_code, timezone) values (...), (...);`
 *  out of the migration's raw text -- no DB, no SQL parser, just the one row shape this specific
 *  statement is known to use (`('AAA', 'Zone')`). */
function parseSqlSeed(sql: string): Record<string, string> {
  const start = sql.indexOf('insert into private.area_code_timezones');
  if (start === -1) {
    throw new Error('area_code_timezones INSERT not found in the migration file');
  }
  const terminator = sql.indexOf(';', start);
  const block = sql.slice(start, terminator === -1 ? undefined : terminator);
  const rowPattern = /\(\s*'(\d{3})'\s*,\s*'([^']+)'\s*\)/g;
  const result: Record<string, string> = {};
  let match: RegExpExecArray | null;
  let rowCount = 0;
  while ((match = rowPattern.exec(block)) !== null) {
    result[match[1]] = match[2];
    rowCount++;
  }
  if (rowCount === 0) {
    throw new Error('parsed zero rows out of the area_code_timezones INSERT -- regex is stale');
  }
  return result;
}

Deno.test('area-code-tz: the Deno and browser copies have the same entry count', () => {
  const sharedCount = Object.keys(SHARED).length;
  const webCount = Object.keys(WEB).length;
  if (sharedCount !== webCount) {
    throw new Error(`_shared has ${sharedCount} entries, apps/web has ${webCount}`);
  }
  if (sharedCount === 0) {
    throw new Error('positive control: both tables parsed as empty -- the import itself is broken');
  }
});

Deno.test('area-code-tz: the Deno and browser copies are byte-for-byte identical', () => {
  const sharedKeys = Object.keys(SHARED).sort();
  const webKeys = Object.keys(WEB).sort();
  if (JSON.stringify(sharedKeys) !== JSON.stringify(webKeys)) {
    const onlyInShared = sharedKeys.filter((k) => !webKeys.includes(k));
    const onlyInWeb = webKeys.filter((k) => !sharedKeys.includes(k));
    throw new Error(
      `area code sets differ -- only in _shared: [${onlyInShared.join(', ')}], only in web: [${onlyInWeb.join(', ')}]`
    );
  }
  const mismatches: string[] = [];
  for (const code of sharedKeys) {
    if (SHARED[code] !== WEB[code]) {
      mismatches.push(`${code}: _shared=${SHARED[code]} web=${WEB[code]}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`timezone mismatches: ${mismatches.join('; ')}`);
  }
});

Deno.test('area-code-tz: both TS copies match the SQL seed in 20260924001300 exactly', async () => {
  const migrationText = await Deno.readTextFile(MIGRATION_PATH);
  const sqlSeed = parseSqlSeed(migrationText);

  const sqlKeys = Object.keys(sqlSeed).sort();
  const sharedKeys = Object.keys(SHARED).sort();
  if (JSON.stringify(sqlKeys) !== JSON.stringify(sharedKeys)) {
    const onlyInSql = sqlKeys.filter((k) => !sharedKeys.includes(k));
    const onlyInTs = sharedKeys.filter((k) => !sqlKeys.includes(k));
    throw new Error(
      `SQL seed vs. _shared area code sets differ -- only in SQL: [${onlyInSql.join(', ')}], only in TS: [${onlyInTs.join(', ')}]`
    );
  }

  const mismatches: string[] = [];
  for (const code of sqlKeys) {
    if (sqlSeed[code] !== SHARED[code]) {
      mismatches.push(`${code}: sql=${sqlSeed[code]} ts=${SHARED[code]}`);
    }
    if (sqlSeed[code] !== WEB[code]) {
      mismatches.push(`${code}: sql=${sqlSeed[code]} web=${WEB[code]}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`SQL/TS timezone mismatches: ${mismatches.join('; ')}`);
  }
});

Deno.test(
  'area-code-tz: positive control -- the SQL parser actually catches a real mismatch',
  () => {
    const fakeSql = `insert into private.area_code_timezones (area_code, timezone) values
    ('201', 'America/New_York'),
    ('202', 'America/Chicago');
  `;
    const parsed = parseSqlSeed(fakeSql);
    if (parsed['202'] !== 'America/Chicago') {
      throw new Error('parser sanity check failed -- did not parse the fake row as expected');
    }
    // '202' is really America/New_York in all three real sources -- prove the comparison logic
    // above WOULD have caught this fake mismatch, not just that it currently reports zero diffs.
    if (SHARED['202'] === parsed['202']) {
      throw new Error(
        'positive control is broken: the fake mismatch does not actually differ from the real table'
      );
    }
  }
);

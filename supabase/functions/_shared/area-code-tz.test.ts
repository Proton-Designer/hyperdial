import { assertEquals } from 'jsr:@std/assert@1';
import { timezoneForAreaCode } from './area-code-tz.ts';

// ---------------------------------------------------------------------------
// Positive control: well-known, unambiguous codes in each of the four
// mainland zones plus Alaska/Hawaii.
// ---------------------------------------------------------------------------

Deno.test('timezoneForAreaCode: 212 (NYC) -> Eastern', () => {
  assertEquals(timezoneForAreaCode('212'), 'America/New_York');
});

Deno.test('timezoneForAreaCode: 312 (Chicago) -> Central', () => {
  assertEquals(timezoneForAreaCode('312'), 'America/Chicago');
});

Deno.test('timezoneForAreaCode: 303 (Denver) -> Mountain', () => {
  assertEquals(timezoneForAreaCode('303'), 'America/Denver');
});

Deno.test('timezoneForAreaCode: 213 (LA) -> Pacific', () => {
  assertEquals(timezoneForAreaCode('213'), 'America/Los_Angeles');
});

Deno.test('timezoneForAreaCode: 907 (Anchorage) -> Alaska', () => {
  assertEquals(timezoneForAreaCode('907'), 'America/Anchorage');
});

Deno.test('timezoneForAreaCode: 808 (Honolulu) -> Hawaii', () => {
  assertEquals(timezoneForAreaCode('808'), 'Pacific/Honolulu');
});

Deno.test('timezoneForAreaCode: 480 (Phoenix) -> Arizona (no DST)', () => {
  assertEquals(timezoneForAreaCode('480'), 'America/Phoenix');
});

// ---------------------------------------------------------------------------
// The specific intra-state corrections documented in the header comment.
// ---------------------------------------------------------------------------

Deno.test('timezoneForAreaCode: TX 915 (El Paso) is Mountain, not the rest of TX Central', () => {
  assertEquals(timezoneForAreaCode('915'), 'America/Denver');
  assertEquals(timezoneForAreaCode('713'), 'America/Chicago'); // Houston, for contrast
});

Deno.test(
  'timezoneForAreaCode: IN 219 (NW Indiana, near Chicago) is Central, not IN default Eastern',
  () => {
    assertEquals(timezoneForAreaCode('219'), 'America/Chicago');
    assertEquals(timezoneForAreaCode('317'), 'America/Indiana/Indianapolis'); // Indianapolis, for contrast
  }
);

Deno.test(
  'timezoneForAreaCode: KY 270/364 (western KY) are Central, not KY default Eastern',
  () => {
    assertEquals(timezoneForAreaCode('270'), 'America/Chicago');
    assertEquals(timezoneForAreaCode('364'), 'America/Chicago');
    assertEquals(timezoneForAreaCode('502'), 'America/New_York'); // Louisville, for contrast
  }
);

Deno.test(
  'timezoneForAreaCode: TN 423/838/865 (east TN) are Eastern, not TN default Central',
  () => {
    assertEquals(timezoneForAreaCode('423'), 'America/New_York');
    assertEquals(timezoneForAreaCode('865'), 'America/New_York');
    assertEquals(timezoneForAreaCode('615'), 'America/Chicago'); // Nashville, for contrast
  }
);

// ---------------------------------------------------------------------------
// Unmapped / malformed input never guesses.
// ---------------------------------------------------------------------------

Deno.test('timezoneForAreaCode: non-geographic toll-free-pattern code -> null', () => {
  assertEquals(timezoneForAreaCode('800'), null);
  assertEquals(timezoneForAreaCode('833'), null);
});

Deno.test('timezoneForAreaCode: foreign NANP member (out of scope by design) -> null', () => {
  assertEquals(timezoneForAreaCode('242'), null); // Bahamas
});

Deno.test('timezoneForAreaCode: malformed input -> null', () => {
  assertEquals(timezoneForAreaCode(''), null);
  assertEquals(timezoneForAreaCode(null), null);
  assertEquals(timezoneForAreaCode(undefined), null);
  assertEquals(timezoneForAreaCode('42'), null);
  assertEquals(timezoneForAreaCode('4155'), null);
  assertEquals(timezoneForAreaCode('abc'), null);
});

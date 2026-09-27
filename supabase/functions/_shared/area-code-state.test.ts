import { assertEquals } from 'jsr:@std/assert@1';
import { areaCodeFromE164, stateForAreaCode, stateForE164 } from './area-code-state.ts';

Deno.test('stateForAreaCode: resolves each of the 14 default all-party-consent states', () => {
  assertEquals(stateForAreaCode('415'), 'CA'); // California
  assertEquals(stateForAreaCode('203'), 'CT'); // Connecticut
  assertEquals(stateForAreaCode('305'), 'FL'); // Florida
  assertEquals(stateForAreaCode('312'), 'IL'); // Illinois
  assertEquals(stateForAreaCode('410'), 'MD'); // Maryland
  assertEquals(stateForAreaCode('617'), 'MA'); // Massachusetts
  assertEquals(stateForAreaCode('406'), 'MT'); // Montana
  assertEquals(stateForAreaCode('603'), 'NH'); // New Hampshire
  assertEquals(stateForAreaCode('215'), 'PA'); // Pennsylvania
  assertEquals(stateForAreaCode('206'), 'WA'); // Washington
  assertEquals(stateForAreaCode('702'), 'NV'); // Nevada
  assertEquals(stateForAreaCode('503'), 'OR'); // Oregon
  assertEquals(stateForAreaCode('302'), 'DE'); // Delaware
  assertEquals(stateForAreaCode('313'), 'MI'); // Michigan
});

Deno.test(
  'stateForAreaCode: a non-consent state resolves too (not everything is a consent state)',
  () => {
    assertEquals(stateForAreaCode('212'), 'NY');
    assertEquals(stateForAreaCode('404'), 'GA');
  }
);

Deno.test('stateForAreaCode: unmapped/non-geographic codes return null, never a guess', () => {
  assertEquals(stateForAreaCode('800'), null); // toll-free, non-geographic
  assertEquals(stateForAreaCode('999'), null); // not a real area code
  assertEquals(stateForAreaCode('416'), null); // Toronto, Canada -- out of scope
});

Deno.test('areaCodeFromE164: extracts the 3-digit area code from a +1 E.164 number', () => {
  assertEquals(areaCodeFromE164('+14155551234'), '415');
  assertEquals(areaCodeFromE164('+12125551234'), '212');
});

Deno.test('areaCodeFromE164: null for anything not a well-formed +1 number', () => {
  assertEquals(areaCodeFromE164(null), null);
  assertEquals(areaCodeFromE164(undefined), null);
  assertEquals(areaCodeFromE164(''), null);
  assertEquals(areaCodeFromE164('+442071234567'), null); // UK, not +1
  assertEquals(areaCodeFromE164('4155551234'), null); // missing the leading +1
});

Deno.test('stateForE164: end-to-end convenience wrapper', () => {
  assertEquals(stateForE164('+14155551234'), 'CA');
  assertEquals(stateForE164('+12125551234'), 'NY');
  assertEquals(stateForE164('+18005551234'), null);
  assertEquals(stateForE164(null), null);
});

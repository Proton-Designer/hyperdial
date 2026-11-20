-- TASK-H38: SQL half of the search parity check (same cases as apps/web/scripts/check-contact-search.mts).
-- Needs migration *_h38_recordings_contact_search.sql applied (or run inside begin; <migration>; <this file>; rollback;).
-- Output: one row, failed must be [].
select coalesce(json_agg(json_build_object('query', q, 'text', t, 'expected', expected, 'got', got)) filter (where got <> expected), '[]'::json) as failed
from (
  select q, t, expected, private.search_matches(q, t, phones) as got
  from (values
  ('bow stern', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('Bow Stern', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('bowstern', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('BOWSTERN marketing', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('marketing bow', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('communications stern', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('850 570', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('(850) 570-7252', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('8505707252', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('+1 850 570 7252', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('570-7252', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], true),
  ('bow tie', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], false),
  ('850 571', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], false),
  ('99', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], false),
  ('zzz', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], false),
  ('8505707253', 'Bowstern Marketing Communications', array['+18505707252','(850) 570-7252']::text[], false),
  ('jose nunez smith', 'José Núñez-Smith', array[]::text[], true),
  ('obrien sons', 'O''Brien & Sons', array[]::text[], true),
  ('lodz', 'Łódź Bakery', array[]::text[], true),
  ('strasse', 'Straße Café', array[]::text[], true),
  ('odense', 'Ødense Træ', array[]::text[], true),
  ('dordevic', 'Đorđević Co', array[]::text[], true),
  ('sogut', 'Söğüt Ltd', array[]::text[], true),
  ('محمد', 'محمد للتجارة', array[]::text[], true),
  ('للتجارة', 'محمد للتجارة', array[]::text[], true),
  ('مرحبا', 'Acme Roofing', array[]::text[], false),
  ('иван', 'Иван Петров ООО', array[]::text[], true),
  ('!!!', 'Acme Roofing', array[]::text[], false),
  ('   ', 'Acme Roofing', array[]::text[], true),
  ('()', 'Acme', array['+12145550123']::text[], false),
  ('12', 'Acme', array['+12145550123']::text[], false),
  ('214', 'Acme', array['+12145550123']::text[], true),
  ('214x', 'Acme 214 Plumbing', array[]::text[], false)
  ) as v(q, t, phones, expected)
) r;

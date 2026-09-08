-- Feature: ldr-companion-app (Task 18.1, Requirements 9.4 and 9.5)
--
-- `relationship_dates` was originally constrained with PostgreSQL's one-
-- argument btrim(), which removes only ordinary spaces. The shared domain
-- validator uses JavaScript String#trim(), so a title consisting of tabs or
-- line breaks could previously pass the database constraint. PostgreSQL's
-- `date` type also permits years outside the CalendarDate domain (1..9999).
--
-- This migration makes the database's acceptance boundary match the domain:
--   * title: 1..100 characters after ECMAScript-WhiteSpace trimming; and
--   * date: a real PostgreSQL calendar date whose year is 0001..9999.
--
-- `date` already enforces real month/day combinations, including Gregorian
-- leap years. The explicit range below supplies the missing CalendarDate year
-- boundary. RLS/grants are deliberately unchanged: migration 20260826062549
-- already grants authenticated callers SELECT/INSERT/UPDATE/DELETE and scopes
-- every verb to `app.current_pairing(auth.uid())` plus `session_epoch_ok`.

-- This is ECMAScript's current WhiteSpace + LineTerminator set. Supplying it
-- explicitly is important: PostgreSQL's default btrim(title) trims only U+0020.
-- The escape form keeps every code point visible and stable across editors.
create or replace function app.ecmascript_trimmed_utf16_length (value text)
  returns integer
  language plpgsql
  immutable
  strict
as $$
declare
  trimmed text := btrim(
    value,
    E' \t\n\r\f\v\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
  );
  result integer := 0;
begin
  -- JavaScript String#length counts UTF-16 code units, while PostgreSQL
  -- char_length counts Unicode code points. Astral characters therefore count
  -- twice in the shared TypeScript validator and must count twice here too.
  for position in 1..char_length(trimmed) loop
    result := result + case
      when ascii(substr(trimmed, position, 1)) > 65535 then 2
      else 1
    end;
  end loop;
  return result;
end;
$$;

comment on function app.ecmascript_trimmed_utf16_length (text) is
  'Length after ECMAScript whitespace trimming, counted as JavaScript UTF-16 code units.';

alter table public.relationship_dates
  drop constraint if exists relationship_dates_title_len;

alter table public.relationship_dates
  add constraint relationship_dates_title_len
    check (
      app.ecmascript_trimmed_utf16_length(title) between 1 and 100
    ),
  add constraint relationship_dates_calendar_date_range
    check (date between date '0001-01-01' and date '9999-12-31');

comment on table public.relationship_dates is
  'Pairing-scoped relationship dates (Req 9). Titles are 1..100 characters after ECMAScript whitespace trimming; dates are valid CalendarDate values with year 1..9999.';

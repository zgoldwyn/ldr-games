-- Migration: authoritative calendar-reminder scheduling and delivery lifecycle
-- Feature: ldr-companion-app (task 18.2)
--
-- A reminder's trigger is derived state: accepting client-written trigger
-- timestamps (or a client-selected pairing) would let a modified client create
-- a reminder that does not correspond to its date.  The two RPCs below are
-- therefore the only mutation path.  They are callable only by service_role;
-- the authenticated calendar Edge Function authenticates the actor and passes
-- its id and session epoch into set_calendar_reminder.
--
-- Task 20.2 owns the cron delivery job.  This migration deliberately supplies
-- only its transactional row-lifecycle helper, not a scheduler.

-- ---------------------------------------------------------------------------
-- Exact Duration representation and parent-pairing integrity
-- ---------------------------------------------------------------------------
-- Duration is milliseconds throughout @ldr/core.  The old seconds integer
-- column silently lost precision, so convert it before any new writer exists.
alter table public.reminders
  rename column lead_time_seconds to lead_time_ms;

alter table public.reminders
  alter column lead_time_ms type bigint using lead_time_ms::bigint * 1000,
  drop constraint if exists reminders_lead_time_range,
  add constraint reminders_lead_time_range
    check (lead_time_ms between 60000 and 31536000000);

-- `id` is already unique as the relationship_dates primary key.  This explicit
-- candidate key lets the child's composite FK prove that its copied pairing_id
-- belongs to exactly the date it names; an unrelated pairing can no longer be
-- attached to a valid date id.
alter table public.relationship_dates
  add constraint relationship_dates_id_pairing_id_key unique (id, pairing_id);

alter table public.reminders
  drop constraint if exists reminders_date_id_fkey,
  add constraint reminders_date_pairing_fkey
    foreign key (date_id, pairing_id)
    references public.relationship_dates (id, pairing_id)
    on delete cascade;

comment on column public.reminders.lead_time_ms is
  'Exact Duration in milliseconds: 60000 (1 minute) through 31536000000 (365 days), inclusive (Req 10.1).';
comment on constraint reminders_date_pairing_fkey on public.reminders is
  'The reminder pairing must be the owning relationship date pairing; deleting that date cascades its reminders (Req 10.4).';

-- Clients can still read pairing-scoped reminders through the existing RLS
-- policy, but must not write a trigger/status directly or through PostgREST.
-- Service-role-only RPCs below re-check membership, epoch, date ownership, and
-- all derived timing invariants inside the transaction.
revoke insert, update, delete on public.reminders from authenticated;

-- ---------------------------------------------------------------------------
-- public.set_calendar_reminder
-- ---------------------------------------------------------------------------
create or replace function public.set_calendar_reminder (
  p_date            uuid,
  p_actor           uuid,
  p_epoch           integer,
  p_lead_time_ms    bigint,
  p_next_trigger_at timestamptz,
  p_now             timestamptz default now()
)
  returns table (
    result_code     text,
    reminder_id     uuid,
    date_id         uuid,
    pairing_id      uuid,
    lead_time_ms    bigint,
    next_trigger_at timestamptz,
    status          reminder_status
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing_id       uuid;
  v_pairing          pairings%rowtype;
  v_date             relationship_dates%rowtype;
  v_actor_pairing    uuid;
  v_session_epoch    integer;
  v_today            date;
  v_occurrence       date;
  v_candidate_year   integer;
  v_last_day         integer;
  v_expected_trigger timestamptz;
  v_reminder         reminders%rowtype;
  v_now              timestamptz := coalesce(p_now, now());
begin
  -- Obtain the parent id first, then lock in the global parent-before-child
  -- order used by pairing dissolution: pairing -> date -> reminder.  The first
  -- read is only a locator; every authorization fact is re-read under a lock.
  select d.pairing_id into v_pairing_id
  from relationship_dates as d
  where d.id = p_date;

  if not found then
    return query select 'DATE_NOT_FOUND'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  select * into v_pairing
  from pairings
  where id = v_pairing_id
  for share;

  if not found
     or v_pairing.status <> 'active'
     or p_actor is null
     or (p_actor <> v_pairing.member_a and p_actor <> v_pairing.member_b) then
    return query select 'PAIRING_REQUIRED'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  -- Re-check the actor's current account pointer and current session epoch
  -- after taking the pairing lock.  This closes a stale-token/unlink race
  -- between Edge Function authentication and the privileged mutation.
  select a.pairing_id into v_actor_pairing
  from accounts as a
  where a.id = p_actor
  for share;

  select epoch into v_session_epoch
  from account_session as s
  where s.account_id = p_actor
  for share;

  if v_actor_pairing is distinct from v_pairing.id then
    return query select 'PAIRING_REQUIRED'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  if p_epoch is null or v_session_epoch is distinct from p_epoch then
    return query select 'SESSION_SUPERSEDED'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  select * into v_date
  from relationship_dates as d
  where d.id = p_date
    and d.pairing_id = v_pairing.id
  for share;

  if not found then
    return query select 'DATE_NOT_FOUND'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  if p_lead_time_ms is null
     or p_lead_time_ms < 60000
     or p_lead_time_ms > 31536000000
     or p_next_trigger_at is null then
    return query select 'INVALID_LEAD_TIME'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  -- This mirrors `nextOccurrence` + `reminderTriggerTime` in @ldr/core.
  -- PostgreSQL dates are Gregorian, and make_date's explicit last-day clamp
  -- preserves the core's February-29 behavior in non-leap years.
  v_today := (v_now at time zone 'UTC')::date;
  if v_date.recurring then
    v_candidate_year := extract(year from v_today)::integer;
    v_last_day := extract(day from (
      date_trunc('month', make_date(v_candidate_year, extract(month from v_date.date)::integer, 1))
      + interval '1 month - 1 day'
    ))::integer;
    v_occurrence := make_date(
      v_candidate_year,
      extract(month from v_date.date)::integer,
      least(extract(day from v_date.date)::integer, v_last_day)
    );
    if v_occurrence < v_today then
      v_candidate_year := v_candidate_year + 1;
      -- CalendarDate's valid range ends at 9999.  A date that has already
      -- passed in that year has no representable next occurrence.
      if v_candidate_year > 9999 then
        return query select 'INVALID_LEAD_TIME'::text, null::uuid, null::uuid,
          null::uuid, null::bigint, null::timestamptz, null::reminder_status;
        return;
      end if;
      v_last_day := extract(day from (
        date_trunc('month', make_date(v_candidate_year, extract(month from v_date.date)::integer, 1))
        + interval '1 month - 1 day'
      ))::integer;
      v_occurrence := make_date(
        v_candidate_year,
        extract(month from v_date.date)::integer,
        least(extract(day from v_date.date)::integer, v_last_day)
      );
    end if;
  else
    v_occurrence := v_date.date;
  end if;

  v_expected_trigger := (v_occurrence::timestamp at time zone 'UTC')
    - (p_lead_time_ms * interval '1 millisecond');

  -- The server derives the timestamp and treats caller input only as a
  -- compare-against value.  This detects an Edge deployment/client mismatch
  -- without ever persisting a forged trigger.
  if v_expected_trigger <= v_now
     or p_next_trigger_at <> v_expected_trigger then
    return query select 'INVALID_LEAD_TIME'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  insert into reminders (
    date_id, pairing_id, lead_time_ms, next_trigger_at, status, created_at, updated_at
  ) values (
    v_date.id, v_pairing.id, p_lead_time_ms, v_expected_trigger, 'scheduled', v_now, v_now
  ) returning * into v_reminder;

  return query select 'OK'::text, v_reminder.id, v_reminder.date_id,
    v_reminder.pairing_id, v_reminder.lead_time_ms, v_reminder.next_trigger_at,
    v_reminder.status;
end;
$$;

comment on function public.set_calendar_reminder (uuid, uuid, integer, bigint, timestamptz, timestamptz) is
  'Service-role-only atomic reminder set: locks and rechecks actor pairing/session, derives occurrence-minus-millisecond Duration, and persists only a future trusted trigger (Req 10.1, 10.2, 10.4).';

revoke execute on function public.set_calendar_reminder (uuid, uuid, integer, bigint, timestamptz, timestamptz)
  from public;
grant execute on function public.set_calendar_reminder (uuid, uuid, integer, bigint, timestamptz, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- public.advance_calendar_reminder_after_delivery
-- ---------------------------------------------------------------------------
-- Called by Task 20.2's delivery loop under service_role.  It is idempotent:
-- only a currently scheduled row advances; a replay returns its current row
-- unchanged.  Date/pairing/reminder locks stop a date deletion or dissolution
-- from racing a delivery into a resurrected scheduled reminder.
create or replace function public.advance_calendar_reminder_after_delivery (
  p_reminder     uuid,
  p_delivered_at timestamptz default now()
)
  returns table (
    result_code     text,
    reminder_id     uuid,
    date_id         uuid,
    pairing_id      uuid,
    lead_time_ms    bigint,
    next_trigger_at timestamptz,
    status          reminder_status
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing_id     uuid;
  v_pairing        pairings%rowtype;
  v_date_id        uuid;
  v_date           relationship_dates%rowtype;
  v_reminder       reminders%rowtype;
  v_occurrence     date;
  v_next_year      integer;
  v_last_day       integer;
  v_next_occurrence date;
  v_next_trigger   timestamptz;
  v_delivered_at   timestamptz := coalesce(p_delivered_at, now());
begin
  -- Locate parents first, then take locks in pairing -> date -> reminder
  -- order.  Do not calculate recurrence from delivery time: a delivery at the
  -- trigger normally precedes its occurrence, which would re-arm the same one.
  select r.pairing_id, r.date_id into v_pairing_id, v_date_id
  from reminders as r
  where r.id = p_reminder;

  if not found then
    return query select 'REMINDER_NOT_FOUND'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  select * into v_pairing
  from pairings
  where id = v_pairing_id
  for share;

  if not found or v_pairing.status <> 'active' then
    return query select 'PAIRING_REQUIRED'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  select * into v_date
  from relationship_dates as d
  where d.id = v_date_id
    and d.pairing_id = v_pairing.id
  for share;

  if not found then
    return query select 'DATE_NOT_FOUND'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  select * into v_reminder
  from reminders as r
  where r.id = p_reminder
    and r.date_id = v_date.id
    and r.pairing_id = v_pairing.id
  for update;

  if not found then
    return query select 'REMINDER_NOT_FOUND'::text, null::uuid, null::uuid,
      null::uuid, null::bigint, null::timestamptz, null::reminder_status;
    return;
  end if;

  if v_reminder.status <> 'scheduled' then
    return query select 'ALREADY_PROCESSED'::text, v_reminder.id, v_reminder.date_id,
      v_reminder.pairing_id, v_reminder.lead_time_ms, v_reminder.next_trigger_at,
      v_reminder.status;
    return;
  end if;

  if not v_date.recurring then
    update reminders
    set status = 'delivered', updated_at = v_delivered_at
    where id = v_reminder.id
    returning * into v_reminder;
  else
    -- The just-delivered occurrence is encoded exactly by the scheduled
    -- trigger plus its millisecond lead.  Start after THAT occurrence, then
    -- keep advancing until the trigger itself is future.  Delivery may have
    -- been deferred while both clients were offline for more than a year; in
    -- that case merely adding one year would re-arm an already-due reminder.
    -- Use the parent date's original month/day for every candidate so a Feb 29
    -- date returns to Feb 29 when a later candidate year is a leap year.
    v_occurrence := ((v_reminder.next_trigger_at
      + (v_reminder.lead_time_ms * interval '1 millisecond')) at time zone 'UTC')::date;
    v_next_year := extract(year from v_occurrence)::integer + 1;
    loop
      -- CalendarDate is bounded to year 9999.  A recurring occurrence
      -- delivered in its final supported year has no representable next annual
      -- occurrence, so it completes instead of overflowing make_date or
      -- rearming an invalid row forever.
      if v_next_year > 9999 then
        update reminders
        set status = 'delivered', updated_at = v_delivered_at
        where id = v_reminder.id
        returning * into v_reminder;

        return query select 'OK'::text, v_reminder.id, v_reminder.date_id,
          v_reminder.pairing_id, v_reminder.lead_time_ms, v_reminder.next_trigger_at,
          v_reminder.status;
        return;
      end if;

      v_last_day := extract(day from (
        date_trunc('month', make_date(v_next_year, extract(month from v_date.date)::integer, 1))
        + interval '1 month - 1 day'
      ))::integer;
      v_next_occurrence := make_date(
        v_next_year,
        extract(month from v_date.date)::integer,
        least(extract(day from v_date.date)::integer, v_last_day)
      );
      v_next_trigger := (v_next_occurrence::timestamp at time zone 'UTC')
        - (v_reminder.lead_time_ms * interval '1 millisecond');
      exit when v_next_trigger > v_delivered_at;
      v_next_year := v_next_year + 1;
    end loop;

    update reminders
    set status = 'scheduled', next_trigger_at = v_next_trigger, updated_at = v_delivered_at
    where id = v_reminder.id
    returning * into v_reminder;
  end if;

  return query select 'OK'::text, v_reminder.id, v_reminder.date_id,
    v_reminder.pairing_id, v_reminder.lead_time_ms, v_reminder.next_trigger_at,
    v_reminder.status;
end;
$$;

comment on function public.advance_calendar_reminder_after_delivery (uuid, timestamptz) is
  'Service-role-only delivery lifecycle: marks one-off reminders delivered and rearms recurring reminders at the first future annual trigger, preserving exact millisecond lead time (Req 10.5).';

revoke execute on function public.advance_calendar_reminder_after_delivery (uuid, timestamptz)
  from public;
grant execute on function public.advance_calendar_reminder_after_delivery (uuid, timestamptz)
  to service_role;

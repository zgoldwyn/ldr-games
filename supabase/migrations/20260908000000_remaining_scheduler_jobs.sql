-- Feature: ldr-companion-app (task 20.2)
--
-- Remaining time-based transitions driven transactionally by pg_cron:
--   * deliver due relationship-date reminders                 (Req 10.3)
--   * revoke sessions after 30 days without activity          (Req 2.6)
--   * discard notifications strictly older than 30 days       (Req 11.5)
--
-- Each function accepts p_now so its boundary can be bracketed without a
-- wall-clock wait. They are service-role-only, while cron runs as postgres.

-- Record whether a registry row has already been expired. Login clears this
-- marker; the epoch bump remains the authorization boundary for old tokens.
alter table public.account_session
  add column if not exists expired_at timestamptz;

comment on column public.account_session.expired_at is
  'When the inactivity scheduler revoked this registry epoch. Cleared by a new login (Req 2.6).';

create index if not exists account_session_active_activity_idx
  on public.account_session (last_activity_at)
  where expired_at is null;

create index if not exists notifications_created_idx
  on public.notifications (created_at);

-- A new login always starts an active registry entry, including after the
-- inactivity scheduler marked the preceding epoch expired.
create or replace function public.bump_session_epoch (
  uid uuid,
  p_client jsonb default '{}'::jsonb
)
  returns integer
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
  insert into account_session (
    account_id, epoch, client, last_activity_at, updated_at, expired_at
  )
  values (uid, 1, coalesce(p_client, '{}'::jsonb), now(), now(), null)
  on conflict (account_id) do update
    set epoch            = account_session.epoch + 1,
        client           = coalesce(excluded.client, account_session.client),
        last_activity_at = now(),
        updated_at       = now(),
        expired_at       = null
  returning epoch;
$$;

-- An expired registry is denied even if an Auth refresh races the cron job and
-- receives the newly bumped epoch. Only bump_session_epoch clears the marker.
create or replace function app.session_epoch_ok (uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from account_session s
    where s.account_id = uid
      and s.epoch = app.jwt_epoch()
      and s.expired_at is null
  );
$$;

comment on function app.session_epoch_ok (uuid) is
  'Session guard: JWT epoch must match the active, non-expired account_session row (Req 2.6-2.9).';

-- ===========================================================================
-- Requirement 10.3 — create both partners' durable reminder notifications
-- ===========================================================================
create or replace function public.deliver_due_calendar_reminders (
  p_now timestamptz default now()
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_due           record;
  v_advanced      record;
  v_pairing       pairings%rowtype;
  v_date          relationship_dates%rowtype;
  v_notifications jsonb;
  v_trigger_ms    bigint;
begin
  for v_due in
    select r.id, r.date_id, r.pairing_id, r.next_trigger_at
      from reminders r
     where r.status = 'scheduled'
       and r.next_trigger_at <= p_now
     order by r.next_trigger_at, r.id
     for update skip locked
  loop
    -- The helper owns one-off completion and recurring rescheduling, including
    -- delayed delivery and February-29 behavior (task 18.2 / Req 10.5).
    select * into v_advanced
      from public.advance_calendar_reminder_after_delivery(v_due.id, p_now);

    if v_advanced.result_code <> 'OK' then
      continue;
    end if;

    select * into v_pairing from pairings where id = v_due.pairing_id;
    select * into v_date from relationship_dates where id = v_due.date_id;
    if not found or v_pairing.id is null or v_pairing.status <> 'active' then
      continue;
    end if;

    v_trigger_ms := (extract(epoch from v_due.next_trigger_at) * 1000)::bigint;
    v_notifications := jsonb_build_array(
      jsonb_build_object(
        'recipient', v_pairing.member_a,
        'category', 'reminder',
        'payload', jsonb_build_object(
          'kind', 'relationship_date_reminder',
          'reminderId', v_due.id,
          'dateId', v_due.date_id,
          'title', v_date.title,
          'triggerAt', v_trigger_ms
        ),
        'dedupe_key', 'reminder:' || v_due.id::text || ':' || v_trigger_ms::text
      ),
      jsonb_build_object(
        'recipient', v_pairing.member_b,
        'category', 'reminder',
        'payload', jsonb_build_object(
          'kind', 'relationship_date_reminder',
          'reminderId', v_due.id,
          'dateId', v_due.date_id,
          'title', v_date.title,
          'triggerAt', v_trigger_ms
        ),
        'dedupe_key', 'reminder:' || v_due.id::text || ':' || v_trigger_ms::text
      )
    );
    perform app.insert_derived_notifications(v_notifications, p_now);
    return next v_due.id;
  end loop;
end;
$$;

comment on function public.deliver_due_calendar_reminders (timestamptz) is
  'Creates durable reminder notifications for both partners and advances each due reminder transactionally (Req 10.3, 10.5).';

-- ===========================================================================
-- Requirement 2.6 — revoke a registry after 30 days without activity
-- ===========================================================================
create or replace function public.expire_inactive_account_sessions (
  p_now timestamptz default now()
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_account uuid;
begin
  for v_account in
    update account_session s
       set epoch = s.epoch + 1,
           expired_at = p_now,
           updated_at = p_now
     where s.expired_at is null
       -- INACTIVITY_LIMIT_MS = 30 days; the valid window is strict.
       and s.last_activity_at <= p_now - interval '30 days'
    returning s.account_id
  loop
    -- Epoch is authoritative immediately. Removing the GoTrue session also
    -- prevents its refresh token from minting a token for the bumped epoch.
    delete from auth.sessions where user_id = v_account;
    return next v_account;
  end loop;
end;
$$;

comment on function public.expire_inactive_account_sessions (timestamptz) is
  'Bumps inactive session epochs at 30 days and removes their GoTrue sessions so access and refresh tokens cannot revive them (Req 2.6).';

-- ===========================================================================
-- Requirement 11.5 — discard notifications past the retention window
-- ===========================================================================
create or replace function public.discard_expired_notifications (
  p_now timestamptz default now()
)
  returns setof uuid
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  delete from notifications n
   where n.created_at < p_now - interval '30 days'
  returning n.id;
$$;

comment on function public.discard_expired_notifications (timestamptz) is
  'Deletes notifications strictly past the 30-day retention window so no later delivery is possible (Req 11.4, 11.5).';

revoke execute on function public.deliver_due_calendar_reminders (timestamptz) from public;
revoke execute on function public.expire_inactive_account_sessions (timestamptz) from public;
revoke execute on function public.discard_expired_notifications (timestamptz) from public;

grant execute on function public.deliver_due_calendar_reminders (timestamptz) to service_role;
grant execute on function public.expire_inactive_account_sessions (timestamptz) to service_role;
grant execute on function public.discard_expired_notifications (timestamptz) to service_role;

-- ===========================================================================
-- Schedules
-- ===========================================================================
do $$
declare
  v_job text;
begin
  foreach v_job in array array[
    'ldr-reminder-delivery',
    'ldr-session-inactivity',
    'ldr-notification-retention'
  ] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end $$;

-- Minute cadence keeps reminder delivery inside Requirement 10.3's 60s budget.
select cron.schedule(
  'ldr-reminder-delivery',
  '* * * * *',
  $$select public.deliver_due_calendar_reminders(now())$$
);

select cron.schedule(
  'ldr-session-inactivity',
  '17 * * * *',
  $$select public.expire_inactive_account_sessions(now())$$
);

select cron.schedule(
  'ldr-notification-retention',
  '23 * * * *',
  $$select public.discard_expired_notifications(now())$$
);

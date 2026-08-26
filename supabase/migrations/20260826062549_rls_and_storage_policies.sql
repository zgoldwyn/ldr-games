-- Migration: Row Level Security (RLS) policies + private Storage bucket policies
-- Feature: ldr-companion-app (task 2.3)
--
-- Enables RLS on every account-scoped and pairing-scoped table created in tasks
-- 2.1 (20260826062547) and 2.2 (20260826062548) and attaches the authorization
-- policies described in design.md "Data Ownership and Access Rules (RLS)":
--   - pairing-scope predicate            pairing_id = app.current_pairing(auth.uid())
--   - recipient-scope predicate          recipient_account_id = auth.uid()   (notifications)
--   - quiz self-answer withholding       partner rows hidden while phase = 'self_answer'
--   - single-session epoch guard         JWT epoch claim must equal account_session.epoch
--   - private Storage bucket policies    drawing images readable only by the two current partners
--
-- Requirements: 2.5, 2.7, 2.8, 2.9, 4.4, 8.4
--
-- Enforcement model (design "Design Goals" / "Key Design Decisions"):
--   * Clients authenticate as the `authenticated` Postgres role and read/write
--     through RLS-filtered access. RLS is the primary authorization mechanism.
--   * Server-authoritative transitions (move/turn validation, quiz scoring/phase
--     changes, invitation acceptance, unlink, single-session registration, HLC
--     conflict application) run in Edge Functions using the `service_role`, which
--     has BYPASSRLS. Therefore these policies constrain only the `authenticated`
--     role; the `anon` role is granted nothing on these tables.
--   * Helper functions live in a dedicated `app` schema that is NOT exposed by the
--     Data API (config.toml api.schemas = public, graphql_public), so they are not
--     reachable as PostgREST RPCs. They are SECURITY DEFINER so the pairing/epoch
--     lookups can read `accounts` / `account_session` without recursing through the
--     RLS policies defined on those same tables.

-- ===========================================================================
-- Helper schema + functions
-- ===========================================================================

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app.jwt_epoch() -> integer
-- ---------------------------------------------------------------------------
-- Extracts the single-session `epoch` claim minted by the login Edge Function
-- (task sequencing: the custom access-token hook adds this claim). The claim may
-- appear as a top-level claim or under app_metadata depending on how it is minted,
-- so both locations are checked. Returns NULL when absent, which fails the epoch
-- guard closed (a token without a valid epoch is treated as stale, Req 2.7-2.9).
create or replace function app.jwt_epoch ()
  returns integer
  language sql
  stable
as $$
  select coalesce(
    nullif(auth.jwt() ->> 'epoch', ''),
    nullif(auth.jwt() -> 'app_metadata' ->> 'epoch', '')
  )::integer;
$$;

comment on function app.jwt_epoch () is
  'Single-session epoch claim from the JWT (top-level or app_metadata); NULL if absent (Req 2.7-2.9).';

-- ---------------------------------------------------------------------------
-- app.session_epoch_ok(uid uuid) -> boolean
-- ---------------------------------------------------------------------------
-- Single-session guard (Req 2.7-2.9): true only when the caller's JWT epoch claim
-- matches the account's current epoch in account_session. A newer login increments
-- the epoch, so any request bearing the previous (stale) token fails this check and
-- is denied access to shared features (Req 2.5, 2.9). SECURITY DEFINER so it can
-- read account_session regardless of that table's own RLS.
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
  );
$$;

comment on function app.session_epoch_ok (uuid) is
  'Single-session epoch guard: JWT epoch must equal account_session.epoch, else deny (Req 2.7-2.9).';

-- ---------------------------------------------------------------------------
-- app.current_pairing(uid uuid) -> uuid
-- ---------------------------------------------------------------------------
-- Returns the account's CURRENT ACTIVE pairing id, or NULL when unpaired. This is
-- the pairing-scope predicate anchor: a pairing-owned row is visible only when its
-- pairing_id equals this value. On unlink the pairing is marked 'dissolved' and the
-- account's pairing_id is cleared, so this immediately returns NULL for the old
-- pairing and every former-pairing row becomes unreachable (Req 4.4). The join on
-- status = 'active' is belt-and-suspenders so a stale accounts.pairing_id can never
-- re-expose a dissolved pairing's data. SECURITY DEFINER to bypass RLS on accounts.
create or replace function app.current_pairing (uid uuid)
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p.id
  from accounts a
  join pairings p on p.id = a.pairing_id and p.status = 'active'
  where a.id = uid;
$$;

comment on function app.current_pairing (uuid) is
  'Account''s current ACTIVE pairing id (NULL if unpaired); anchor for the pairing-scope RLS predicate (Req 4.4).';

grant execute on function app.jwt_epoch () to authenticated, service_role;
grant execute on function app.session_epoch_ok (uuid) to authenticated, service_role;
grant execute on function app.current_pairing (uuid) to authenticated, service_role;

-- ===========================================================================
-- Account-scoped tables (individual data; survives unlinking, Req 4.4)
-- Predicate: id / account_id = auth.uid()
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- accounts: an account may read only its own row. Mutations (pairing_id set on
-- accept/unlink) are performed by Edge Functions (service_role).
-- ---------------------------------------------------------------------------
alter table accounts enable row level security;
grant select on accounts to authenticated;

create policy accounts_select_self on accounts
  for select to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- account_session: an account may read only its own session registry row (to
-- observe its current epoch / last activity). The epoch itself is set by the
-- login Edge Function (service_role); no client writes. No epoch guard here so a
-- client can always inspect its own session state.
-- ---------------------------------------------------------------------------
alter table account_session enable row level security;
grant select on account_session to authenticated;

create policy account_session_select_self on account_session
  for select to authenticated
  using (account_id = auth.uid());

-- ---------------------------------------------------------------------------
-- auth_attempts: lockout bookkeeping is entirely server-authoritative. RLS is
-- enabled with NO policy for `authenticated`, which denies all client access;
-- only the service_role (BYPASSRLS) in the auth Edge Function may touch it.
-- ---------------------------------------------------------------------------
alter table auth_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- notification_settings: per-account preferences owned by the account.
-- ---------------------------------------------------------------------------
alter table notification_settings enable row level security;
grant select, insert, update on notification_settings to authenticated;

create policy notification_settings_select_self on notification_settings
  for select to authenticated
  using (account_id = auth.uid());

create policy notification_settings_insert_self on notification_settings
  for insert to authenticated
  with check (account_id = auth.uid());

create policy notification_settings_update_self on notification_settings
  for update to authenticated
  using (account_id = auth.uid())
  with check (account_id = auth.uid());

-- ---------------------------------------------------------------------------
-- notifications: recipient-scope predicate (recipient_account_id = auth.uid()).
-- Durable per-recipient rows that survive unlinking (individual data, Req 4.4).
-- The recipient may read their own notifications and acknowledge them (UPDATE);
-- creation is done by Edge Functions (service_role). The epoch guard applies so a
-- displaced (stale-epoch) client can no longer read notifications (Req 2.9).
-- ---------------------------------------------------------------------------
alter table notifications enable row level security;
grant select, update on notifications to authenticated;

create policy notifications_select_recipient on notifications
  for select to authenticated
  using (
    recipient_account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  );

create policy notifications_update_recipient on notifications
  for update to authenticated
  using (
    recipient_account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  )
  with check (
    recipient_account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  );

-- ---------------------------------------------------------------------------
-- pairings: a member may read pairings they belong to (active or dissolved, for
-- history). Creation/dissolution is server-authoritative (invitation-accept /
-- unlink Edge Functions, service_role).
-- ---------------------------------------------------------------------------
alter table pairings enable row level security;
grant select on pairings to authenticated;

create policy pairings_select_member on pairings
  for select to authenticated
  using (member_a = auth.uid() or member_b = auth.uid());

-- ---------------------------------------------------------------------------
-- invitations: the inviter may read their own invitations (e.g. to display or
-- revoke). Acceptance (the exclusivity transaction) is an Edge Function
-- (service_role), so no lookup-by-code select policy is exposed to clients.
-- ---------------------------------------------------------------------------
alter table invitations enable row level security;
grant select on invitations to authenticated;

create policy invitations_select_inviter on invitations
  for select to authenticated
  using (inviter_account_id = auth.uid());

-- ===========================================================================
-- Pairing-scoped tables (pairing-owned data)
-- Predicate: app.session_epoch_ok(auth.uid())
--            AND pairing_id = app.current_pairing(auth.uid())
--
-- The epoch guard is combined with the pairing-scope predicate so that a
-- displaced client (stale epoch) is denied shared-feature access (Req 2.5, 2.9),
-- and dissolution (current_pairing -> NULL) revokes access to the former
-- pairing's data (Req 4.4).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- rt_sessions / async_sessions / quiz_sessions: game & quiz session state is
-- read by both partners but every state transition (moves, turns, phase changes,
-- scoring) is validated and written by Edge Functions (service_role). Clients get
-- SELECT only.
-- ---------------------------------------------------------------------------
alter table rt_sessions enable row level security;
grant select on rt_sessions to authenticated;

create policy rt_sessions_select_pairing on rt_sessions
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

alter table async_sessions enable row level security;
grant select on async_sessions to authenticated;

create policy async_sessions_select_pairing on async_sessions
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

alter table quiz_sessions enable row level security;
grant select on quiz_sessions to authenticated;

create policy quiz_sessions_select_pairing on quiz_sessions
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

-- ---------------------------------------------------------------------------
-- relationship_dates: pairing members create/read/update/delete dates directly
-- (Req 9.x). All four verbs are pairing-scoped + epoch-guarded.
-- ---------------------------------------------------------------------------
alter table relationship_dates enable row level security;
grant select, insert, update, delete on relationship_dates to authenticated;

create policy relationship_dates_select_pairing on relationship_dates
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy relationship_dates_insert_pairing on relationship_dates
  for insert to authenticated
  with check (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy relationship_dates_update_pairing on relationship_dates
  for update to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  )
  with check (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy relationship_dates_delete_pairing on relationship_dates
  for delete to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

-- ---------------------------------------------------------------------------
-- reminders: pairing members manage reminders on their dates (Req 10.x). The
-- reminders.pairing_id column carries the scope directly (ON DELETE CASCADE from
-- the parent date still removes rows regardless of RLS).
-- ---------------------------------------------------------------------------
alter table reminders enable row level security;
grant select, insert, update, delete on reminders to authenticated;

create policy reminders_select_pairing on reminders
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy reminders_insert_pairing on reminders
  for insert to authenticated
  with check (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy reminders_update_pairing on reminders
  for update to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  )
  with check (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

create policy reminders_delete_pairing on reminders
  for delete to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and pairing_id = app.current_pairing(auth.uid())
  );

-- ===========================================================================
-- Quiz catalog (global; readable by any authenticated user)
-- ===========================================================================
alter table quiz_defs enable row level security;
grant select on quiz_defs to authenticated;

create policy quiz_defs_select_all on quiz_defs
  for select to authenticated
  using (app.session_epoch_ok(auth.uid()));

alter table quiz_questions enable row level security;
grant select on quiz_questions to authenticated;

create policy quiz_questions_select_all on quiz_questions
  for select to authenticated
  using (app.session_epoch_ok(auth.uid()));

-- ===========================================================================
-- Quiz self-answers: pairing-scoped + phase-keyed WITHHOLDING (Req 8.4)
-- ===========================================================================
-- quiz_self_answers has no pairing_id column; scope is derived by joining the
-- parent quiz_sessions row. A row is SELECTable when:
--   (a) the caller passes the epoch guard, AND
--   (b) the parent session belongs to the caller's current pairing, AND
--   (c) EITHER the row is the caller's own answer (owner sees own answers always)
--       OR the parent session has advanced past the self_answer phase
--       (phase <> 'self_answer'), i.e. the partner's answers are revealed only in
--       the guessing/complete phases.
-- This is the database-layer withholding: a modified client cannot fetch a
-- partner's answers during self_answer because Postgres refuses to return them.
-- Writes are owner-scoped (a caller may only write their OWN answers, within their
-- current pairing). Phase transitions / scoring run in Edge Functions (service_role).
alter table quiz_self_answers enable row level security;
grant select, insert, update on quiz_self_answers to authenticated;

create policy quiz_self_answers_select_withheld on quiz_self_answers
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_self_answers.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
    and (
      quiz_self_answers.account_id = auth.uid()
      or exists (
        select 1 from quiz_sessions qs
        where qs.id = quiz_self_answers.session_id
          and qs.phase <> 'self_answer'
      )
    )
  );

create policy quiz_self_answers_insert_owner on quiz_self_answers
  for insert to authenticated
  with check (
    app.session_epoch_ok(auth.uid())
    and quiz_self_answers.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_self_answers.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  );

create policy quiz_self_answers_update_owner on quiz_self_answers
  for update to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and quiz_self_answers.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_self_answers.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  )
  with check (
    app.session_epoch_ok(auth.uid())
    and quiz_self_answers.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_self_answers.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  );

-- ===========================================================================
-- Quiz guesses: pairing-scoped; owner writes own guesses (Req 8.6). Both partners
-- may read guesses within the pairing (scoring/reveal is not withheld like answers).
-- ===========================================================================
alter table quiz_guesses enable row level security;
grant select, insert, update on quiz_guesses to authenticated;

create policy quiz_guesses_select_pairing on quiz_guesses
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_guesses.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  );

create policy quiz_guesses_insert_owner on quiz_guesses
  for insert to authenticated
  with check (
    app.session_epoch_ok(auth.uid())
    and quiz_guesses.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_guesses.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  );

create policy quiz_guesses_update_owner on quiz_guesses
  for update to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and quiz_guesses.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_guesses.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  )
  with check (
    app.session_epoch_ok(auth.uid())
    and quiz_guesses.account_id = auth.uid()
    and exists (
      select 1 from quiz_sessions qs
      where qs.id = quiz_guesses.session_id
        and qs.pairing_id = app.current_pairing(auth.uid())
    )
  );

-- ===========================================================================
-- Storage: private `drawings` bucket for async drawing-game images
-- ===========================================================================
-- design "Components and Interfaces" (Async Game Module): drawing images are
-- written to a pairing-scoped Storage bucket; design "Security" requires the
-- bucket to be PRIVATE with Storage RLS policies mirroring the pairing-scope
-- predicate so binary content is readable only by the two CURRENT partners.
--
-- Object-key convention: images are stored under a top-level folder named for the
-- owning pairing id, i.e.  "{pairing_id}/{...}.png". The first path segment
-- (storage.foldername(name))[1] therefore identifies the owning pairing, and the
-- same pairing-scope + epoch predicate used for pairing-owned tables is applied.
-- On dissolution current_pairing() returns NULL, so former partners immediately
-- lose access to the images (Req 4.4).

insert into storage.buckets (id, name, public)
values ('drawings', 'drawings', false)
on conflict (id) do nothing;

-- Read a drawing image: caller must pass the epoch guard and the object's pairing
-- folder must equal the caller's current active pairing.
create policy "drawings_select_pairing" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'drawings'
    and app.session_epoch_ok(auth.uid())
    and (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
  );

-- Upload a drawing image into the caller's own pairing folder.
create policy "drawings_insert_pairing" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'drawings'
    and app.session_epoch_ok(auth.uid())
    and (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
  );

-- Update (overwrite/replace) an image within the caller's own pairing folder.
create policy "drawings_update_pairing" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'drawings'
    and app.session_epoch_ok(auth.uid())
    and (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
  )
  with check (
    bucket_id = 'drawings'
    and app.session_epoch_ok(auth.uid())
    and (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
  );

-- Delete an image within the caller's own pairing folder.
create policy "drawings_delete_pairing" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'drawings'
    and app.session_epoch_ok(auth.uid())
    and (storage.foldername(name))[1] = app.current_pairing(auth.uid())::text
  );

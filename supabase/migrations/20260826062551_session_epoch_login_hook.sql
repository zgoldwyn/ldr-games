-- Migration: single-session login epoch bump + custom access-token claim hook
-- Feature: ldr-companion-app (task 12.2)
--
-- Backs the login Edge Function (supabase/functions/auth-login) and the epoch
-- guard already defined in 20260826062549 (app.session_epoch_ok / app.jwt_epoch).
-- Two pieces are added here:
--
--   1. public.bump_session_epoch(uid, client) -- atomically increments an
--      account's session epoch on a successful login (Req 2.7, 2.8). The login
--      Edge Function calls this via the service role AFTER verifying credentials;
--      the incremented epoch is what displaces every previously issued token.
--
--   2. app.custom_access_token(event) -- the GoTrue "custom access token" auth
--      hook. It embeds the account's current epoch into every minted/refreshed
--      access token (top-level `epoch` claim + app_metadata.epoch) so that
--      app.jwt_epoch() can read it and app.session_epoch_ok() can reject stale
--      tokens (Req 2.7-2.9). Config wiring lives in supabase/config.toml under
--      [auth.hook.custom_access_token].
--
-- Requirements: 2.1, 2.2, 2.7, 2.8, 2.9

-- ---------------------------------------------------------------------------
-- public.bump_session_epoch(uid uuid, p_client jsonb) -> integer
-- ---------------------------------------------------------------------------
-- Atomically raises the account's session epoch and records the new client and
-- activity time, returning the NEW epoch. First login inserts epoch = 1; every
-- subsequent login increments by one. A single INSERT ... ON CONFLICT statement
-- keeps the read-modify-write race-free even under concurrent logins.
--
-- SECURITY DEFINER so it can write account_session regardless of that table's
-- RLS (which grants clients SELECT-only on their own row). Execution is granted
-- ONLY to service_role: the login Edge Function is the sole caller. It lives in
-- `public` (not `app`) purely so the service role can reach it as a PostgREST
-- RPC; the tight grant keeps it off-limits to anon/authenticated callers.
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
  insert into account_session (account_id, epoch, client, last_activity_at, updated_at)
  values (uid, 1, coalesce(p_client, '{}'::jsonb), now(), now())
  on conflict (account_id) do update
    set epoch            = account_session.epoch + 1,
        client           = coalesce(excluded.client, account_session.client),
        last_activity_at = now(),
        updated_at       = now()
  returning epoch;
$$;

comment on function public.bump_session_epoch (uuid, jsonb) is
  'Atomically increments an account''s session epoch on login and returns the new epoch (Req 2.7, 2.8). Service-role only.';

-- Lock the RPC down to the service role (the login Edge Function). Revoke the
-- default PUBLIC execute grant so no client role can bump another account.
revoke execute on function public.bump_session_epoch (uuid, jsonb) from public;
grant execute on function public.bump_session_epoch (uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- app.custom_access_token(event jsonb) -> jsonb  (GoTrue auth hook)
-- ---------------------------------------------------------------------------
-- Runs on every access-token mint (initial sign-in AND refresh). It looks up the
-- account's current epoch and writes it into the token claims so the epoch guard
-- can compare it. The claim is written both top-level (`epoch`) and under
-- `app_metadata.epoch`, matching the two locations app.jwt_epoch() checks. When
-- no session row exists yet (e.g. a token minted before the login function ran)
-- no claim is added, so the guard fails closed and the token is treated as stale.
--
-- Lives in `app` (not Data-API exposed). SECURITY DEFINER so it can read
-- account_session past its RLS. GoTrue invokes it as supabase_auth_admin.
create or replace function app.custom_access_token (event jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  claims        jsonb;
  current_epoch integer;
begin
  select s.epoch
    into current_epoch
    from account_session s
   where s.account_id = (event ->> 'user_id')::uuid;

  claims := coalesce(event -> 'claims', '{}'::jsonb);

  if current_epoch is not null then
    -- Top-level claim (app.jwt_epoch reads `auth.jwt() ->> 'epoch'`).
    claims := jsonb_set(claims, '{epoch}', to_jsonb(current_epoch), true);

    -- Mirror under app_metadata (the second location app.jwt_epoch checks).
    if claims ? 'app_metadata' then
      claims := jsonb_set(
        claims, '{app_metadata,epoch}', to_jsonb(current_epoch), true
      );
    else
      claims := jsonb_set(
        claims, '{app_metadata}', jsonb_build_object('epoch', current_epoch), true
      );
    end if;

    event := jsonb_set(event, '{claims}', claims, true);
  end if;

  return event;
end;
$$;

comment on function app.custom_access_token (jsonb) is
  'GoTrue custom access-token hook: embeds the account session epoch claim so the epoch guard can reject stale tokens (Req 2.7-2.9).';

-- GoTrue runs auth hooks as the supabase_auth_admin role: it needs USAGE on the
-- schema and EXECUTE on the function. Keep the hook off-limits to every other
-- role so it cannot be abused as a claim-injection RPC.
grant usage on schema app to supabase_auth_admin;
grant execute on function app.custom_access_token (jsonb) to supabase_auth_admin;
revoke execute on function app.custom_access_token (jsonb) from authenticated, anon, public;

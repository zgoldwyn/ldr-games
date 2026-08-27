-- Migration: account-id-by-email lookup for lockout recording
-- Feature: ldr-companion-app (task 12.3)
--
-- Backs the lockout wiring in the login Edge Function (supabase/functions/
-- auth-login). The 5-in-15-minutes lockout (Req 2.3) is keyed on account_id, so
-- the login function must resolve an email to its account id BEFORE credentials
-- are verified — including on a *failed* attempt, where GoTrue returns no user.
--
-- Email lives in auth.users (never in application tables, Req 1.6), which is not
-- exposed to PostgREST. This SECURITY DEFINER function reads it on the server
-- and is granted ONLY to service_role (the login Edge Function is the sole
-- caller), mirroring the lock-down pattern used by public.bump_session_epoch in
-- migration 20260826062550. It returns NULL for an unknown email so the caller
-- treats it as an un-attributable failure and still returns the uniform,
-- non-revealing auth error (Req 2.2).
--
-- Requirements: 2.3

create or replace function public.account_id_for_email (p_email text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(p_email)
   limit 1;
$$;

comment on function public.account_id_for_email (text) is
  'Resolves an email to its account id for server-side lockout recording (Req 2.3). Service-role only.';

-- Lock the RPC down to the service role (the login Edge Function). Revoke the
-- default PUBLIC execute grant so no client role can enumerate accounts by email.
revoke execute on function public.account_id_for_email (text) from public;
grant execute on function public.account_id_for_email (text) to service_role;

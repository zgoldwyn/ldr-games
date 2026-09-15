-- Permanently delete one game and its session-scoped data in a single transaction.
-- Only the current, epoch-valid member of the owning pairing may invoke this plan.

create or replace function public.delete_game_session(
  p_session_id uuid,
  p_kind text,
  p_actor uuid,
  p_epoch bigint
)
returns table(result_code text, deleted_pairing_id uuid, member_a uuid, member_b uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_actor_pairing uuid;
  v_session_pairing uuid;
  v_member_a uuid;
  v_member_b uuid;
begin
  if not exists (
    select 1
    from public.account_session s
    where s.account_id = p_actor and s.epoch = p_epoch
  ) then
    return query select 'SESSION_SUPERSEDED'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select a.pairing_id into v_actor_pairing
  from public.accounts a
  where a.id = p_actor;

  if v_actor_pairing is null then
    return query select 'PAIRING_REQUIRED'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if p_kind = 'rt' then
    select s.pairing_id into v_session_pairing
    from public.rt_sessions s
    where s.id = p_session_id;
  elsif p_kind = 'async' then
    select s.pairing_id into v_session_pairing
    from public.async_sessions s
    where s.id = p_session_id;
  else
    return query select 'INVALID_SESSION_STATE'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_session_pairing is null or v_session_pairing <> v_actor_pairing then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select p.member_a, p.member_b into v_member_a, v_member_b
  from public.pairings p
  where p.id = v_session_pairing
    and p.status = 'active'
    and p_actor in (p.member_a, p.member_b);

  if v_member_a is null or v_member_b is null then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  delete from public.notifications n
  where n.payload ->> 'sessionId' = p_session_id::text;

  if p_kind = 'rt' then
    delete from public.rt_sessions s where s.id = p_session_id;
  else
    -- battleship_placements is ON DELETE CASCADE from async_sessions.
    delete from public.async_sessions s where s.id = p_session_id;
  end if;

  return query select 'OK'::text, v_session_pairing, v_member_a, v_member_b;
end;
$$;

revoke all on function public.delete_game_session(uuid, text, uuid, bigint) from public;
grant execute on function public.delete_game_session(uuid, text, uuid, bigint) to service_role;

-- Private per-player Battleship fleets. Opponent coordinates must never live in
-- async_sessions.game_state because that row is readable by both partners.

create table public.battleship_placements (
  session_id uuid not null references public.async_sessions(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  fleet jsonb not null,
  placed_at timestamptz not null default now(),
  primary key (session_id, account_id)
);

alter table public.battleship_placements enable row level security;
grant select on public.battleship_placements to authenticated;

create policy battleship_placements_select_own
on public.battleship_placements for select to authenticated
using (
  account_id = auth.uid()
  and app.session_epoch_ok(auth.uid())
  and exists (
    select 1 from public.async_sessions s
    where s.id = session_id
      and s.pairing_id = app.current_pairing(auth.uid())
  )
);

create or replace function public.battleship_place_fleet(
  p_session uuid,
  p_actor uuid,
  p_fleet jsonb,
  p_now timestamptz
)
returns table (
  result_code text,
  session_id uuid,
  pairing_id uuid,
  game_id text,
  state text,
  active_turn_holder uuid,
  turn_pending_since timestamptz,
  game_state jsonb,
  outcome jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.async_sessions%rowtype;
  v_ready jsonb;
begin
  select * into v_session from public.async_sessions where id = p_session for update;
  if not found or v_session.game_id <> 'battleship' then
    return query select 'SESSION_NOT_FOUND', null::uuid, null::uuid, null::text,
      null::text, null::uuid, null::timestamptz, null::jsonb, null::jsonb;
    return;
  end if;
  if v_session.state <> 'active'
     or not (p_actor = any (array[
       (v_session.game_state -> 'players' ->> 0)::uuid,
       (v_session.game_state -> 'players' ->> 1)::uuid
     ]))
     or coalesce(v_session.game_state #>> '{ruleset,phase}', 'placement') <> 'placement' then
    return query select 'INVALID_SESSION_STATE', v_session.id, v_session.pairing_id,
      v_session.game_id, v_session.state::text, v_session.active_turn_holder,
      v_session.turn_pending_since, v_session.game_state, v_session.outcome;
    return;
  end if;

  insert into public.battleship_placements(session_id, account_id, fleet, placed_at)
  values (p_session, p_actor, p_fleet, p_now)
  on conflict on constraint battleship_placements_pkey do update
    set fleet = excluded.fleet, placed_at = excluded.placed_at;

  select coalesce(jsonb_agg(account_id order by account_id), '[]'::jsonb)
    into v_ready
    from public.battleship_placements
    where battleship_placements.session_id = p_session;

  update public.async_sessions s
  set game_state = jsonb_set(
        jsonb_set(s.game_state, '{ruleset,readyPlayers}', v_ready, true),
        '{ruleset,phase}',
        case when jsonb_array_length(v_ready) = 2 then '"playing"'::jsonb
             else '"placement"'::jsonb end,
        true
      ),
      turn_pending_since = case when jsonb_array_length(v_ready) = 2 then p_now
                                else s.turn_pending_since end,
      updated_at = p_now
  where s.id = p_session
  returning s.* into v_session;

  return query select 'OK', v_session.id, v_session.pairing_id, v_session.game_id,
    v_session.state::text, v_session.active_turn_holder, v_session.turn_pending_since,
    v_session.game_state, v_session.outcome;
end;
$$;

revoke all on function public.battleship_place_fleet(uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.battleship_place_fleet(uuid, uuid, jsonb, timestamptz)
  to service_role;

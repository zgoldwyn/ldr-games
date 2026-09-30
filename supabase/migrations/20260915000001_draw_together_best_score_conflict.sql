-- Fix PL/pgSQL ambiguity between RETURNS TABLE output variables and the best
-- score primary-key column names in the terminal-game upsert.
create or replace function public.draw_together_commit(
  p_session uuid,
  p_actor uuid,
  p_expected_updated_at timestamptz,
  p_game_state jsonb,
  p_session_state public.rt_session_state,
  p_outcome jsonb,
  p_choice_word_ids uuid[],
  p_active_word_id uuid,
  p_choice_deadline timestamptz,
  p_active_started_at timestamptz,
  p_now timestamptz
)
returns table (
  id uuid,
  pairing_id uuid,
  game_id text,
  state public.rt_session_state,
  game_state jsonb,
  outcome jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.rt_sessions%rowtype;
  v_duration integer;
  v_score integer;
begin
  select * into v_session
  from public.rt_sessions s
  where s.id = p_session
  for update;

  if not found
    or v_session.game_id <> 'draw-together'
    or v_session.state not in ('active', 'paused') then
    return;
  end if;

  if v_session.updated_at <> p_expected_updated_at then
    return;
  end if;

  if not exists (
    select 1 from public.pairings p
    where p.id = v_session.pairing_id
      and p.status = 'active'
      and p_actor in (p.member_a, p.member_b)
  ) then
    return;
  end if;

  insert into public.draw_together_secrets (
    session_id, choice_word_ids, active_word_id, choice_deadline,
    active_started_at, updated_at
  ) values (
    p_session, coalesce(p_choice_word_ids, '{}'), p_active_word_id,
    p_choice_deadline, p_active_started_at, p_now
  )
  on conflict (session_id) do update set
    choice_word_ids = excluded.choice_word_ids,
    active_word_id = excluded.active_word_id,
    choice_deadline = excluded.choice_deadline,
    active_started_at = excluded.active_started_at,
    updated_at = excluded.updated_at;

  update public.rt_sessions s set
    game_state = p_game_state,
    state = p_session_state,
    outcome = p_outcome,
    updated_at = p_now
  where s.id = p_session;

  if p_session_state = 'terminal' then
    v_duration := (p_game_state ->> 'matchDurationSeconds')::integer;
    v_score := greatest(0, (p_game_state ->> 'score')::integer);
    insert into public.draw_together_best_scores (
      pairing_id, duration_seconds, score, session_id, achieved_at
    ) values (
      v_session.pairing_id, v_duration, v_score, p_session, p_now
    )
    on conflict on constraint draw_together_best_scores_pkey do update set
      score = excluded.score,
      session_id = excluded.session_id,
      achieved_at = excluded.achieved_at
    where excluded.score > public.draw_together_best_scores.score;
  end if;

  return query
  select s.id, s.pairing_id, s.game_id, s.state, s.game_state, s.outcome, s.updated_at
  from public.rt_sessions s
  where s.id = p_session;
end;
$$;

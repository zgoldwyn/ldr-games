-- Draw Together: private word catalog/answer state and duration-scoped best scores.
-- The shared rt_sessions.game_state NEVER contains the active answer.

create table public.draw_together_words (
  id uuid primary key default gen_random_uuid(),
  word text not null unique check (length(trim(word)) between 2 and 40),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  catalog_version integer not null default 1 check (catalog_version > 0),
  enabled boolean not null default true
);

alter table public.draw_together_words enable row level security;
revoke all on public.draw_together_words from anon, authenticated;
grant select on public.draw_together_words to service_role;

insert into public.draw_together_words (word, difficulty) values
  ('apple', 'easy'), ('balloon', 'easy'), ('bicycle', 'easy'),
  ('birthday cake', 'easy'), ('cat', 'easy'), ('flower', 'easy'),
  ('house', 'easy'), ('ice cream', 'easy'), ('moon', 'easy'),
  ('pizza', 'easy'), ('rainbow', 'easy'), ('snowman', 'easy'),
  ('sun', 'easy'), ('tree', 'easy'), ('umbrella', 'easy'),
  ('campfire', 'medium'), ('castle', 'medium'), ('dolphin', 'medium'),
  ('fire truck', 'medium'), ('guitar', 'medium'), ('hot air balloon', 'medium'),
  ('lighthouse', 'medium'), ('mermaid', 'medium'), ('roller coaster', 'medium'),
  ('satellite', 'medium'), ('scarecrow', 'medium'), ('skateboard', 'medium'),
  ('treasure chest', 'medium'), ('volcano', 'medium'), ('windmill', 'medium'),
  ('archaeologist', 'hard'), ('constellation', 'hard'), ('disguise', 'hard'),
  ('earthquake', 'hard'), ('gravity', 'hard'), ('imagination', 'hard'),
  ('invisible', 'hard'), ('jealousy', 'hard'), ('migration', 'hard'),
  ('photosynthesis', 'hard'), ('quicksand', 'hard'), ('reflection', 'hard'),
  ('time travel', 'hard'), ('traffic jam', 'hard'), ('wireless', 'hard');

create table public.draw_together_secrets (
  session_id uuid primary key references public.rt_sessions(id) on delete cascade,
  choice_word_ids uuid[] not null default '{}',
  active_word_id uuid references public.draw_together_words(id),
  choice_deadline timestamptz,
  active_started_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.draw_together_secrets enable row level security;
revoke all on public.draw_together_secrets from anon, authenticated;
grant select, insert, update, delete on public.draw_together_secrets to service_role;

create table public.draw_together_best_scores (
  pairing_id uuid not null references public.pairings(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds in (180, 300, 600)),
  score integer not null check (score >= 0),
  session_id uuid not null references public.rt_sessions(id) on delete cascade,
  achieved_at timestamptz not null default now(),
  primary key (pairing_id, duration_seconds)
);

alter table public.draw_together_best_scores enable row level security;
grant select on public.draw_together_best_scores to authenticated;
grant select, insert, update, delete on public.draw_together_best_scores to service_role;

create policy draw_together_best_scores_select_pairing
on public.draw_together_best_scores for select to authenticated
using (
  app.session_epoch_ok(auth.uid())
  and pairing_id = app.current_pairing(auth.uid())
);

-- Commit public state and private answer state under one session-row lock. The
-- Edge Function computes the pure transition; this RPC supplies atomicity and a
-- final membership/concurrency check before either half becomes visible.
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

revoke all on function public.draw_together_commit(
  uuid, uuid, timestamptz, jsonb, public.rt_session_state, jsonb,
  uuid[], uuid, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.draw_together_commit(
  uuid, uuid, timestamptz, jsonb, public.rt_session_state, jsonb,
  uuid[], uuid, timestamptz, timestamptz, timestamptz
) to service_role;

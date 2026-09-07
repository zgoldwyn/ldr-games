-- Migration: atomic quiz session RPCs
-- Feature: ldr-companion-app (task 17.1)
--
-- Quiz transitions are server-authoritative.  The three RPCs below are exposed
-- through PostgREST only to service_role; the Edge Functions authenticate the
-- caller and pass its account id as p_actor.  Each mutation locks the relevant
-- pairing/session rows, re-checks pairing membership and lifecycle state, and
-- returns a stable result code instead of raising an application error.
--
-- The submission RPCs derive validation and phase progression inside the
-- transaction.  Guess matching itself is computed by the trusted Edge Function
-- with the shared core implementation, while this migration increments the
-- locked score atomically.  Two simultaneous last answers or guesses therefore
-- cannot overwrite either answer, score, or phase transition.

-- Client table writes would let a client bypass the phase/scoring transaction.
-- Reads remain available under the existing RLS policies; only the Edge
-- Functions' service_role RPC calls may now mutate quiz answer state.
revoke insert, update on quiz_self_answers from authenticated;
revoke insert, update on quiz_guesses from authenticated;

-- ---------------------------------------------------------------------------
-- public.quiz_start_session
-- ---------------------------------------------------------------------------
create or replace function public.quiz_start_session (
  p_pairing uuid,
  p_actor   uuid,
  p_quiz    uuid,
  p_now     timestamptz default now()
)
  returns table (
    result_code text,
    session_id  uuid,
    phase       quiz_phase,
    scores      jsonb
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing          pairings%rowtype;
  v_member_a_pairing uuid;
  v_member_b_pairing uuid;
  v_session          quiz_sessions%rowtype;
  v_now              timestamptz := coalesce(p_now, now());
begin
  -- Lock in the same parent-before-child order as dissolve_pairing.  This also
  -- prevents a session from being created while the pairing is being dissolved.
  select * into v_pairing
  from pairings
  where id = p_pairing
  for share;

  if not found
     or v_pairing.status <> 'active'
     or p_actor is null
     or (p_actor <> v_pairing.member_a and p_actor <> v_pairing.member_b) then
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- The pairing row and account pointers must agree.  This is normally
  -- guaranteed by the pairing transactions, but it closes a stale/partial
  -- membership race before starting a shared session.
  select pairing_id into v_member_a_pairing
  from accounts where id = v_pairing.member_a for share;
  if not found then
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  select pairing_id into v_member_b_pairing
  from accounts where id = v_pairing.member_b for share;
  if not found
     or v_member_a_pairing is distinct from v_pairing.id
     or v_member_b_pairing is distinct from v_pairing.id then
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- Avoid leaking a foreign-key exception when a stale catalog id is supplied.
  perform 1 from quiz_defs where id = p_quiz for share;
  if not found then
    return query select 'QUIZ_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- A session with no questions could never leave self_answer.  Treat an empty
  -- catalog entry as unavailable, just like an unknown quiz id.
  perform 1 from quiz_questions where quiz_id = p_quiz for share;
  if not found then
    return query select 'QUIZ_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- The partial unique index quiz_sessions_active_per_pairing_uidx is the
  -- final concurrency guard.  A racing start which observed no active row can
  -- still only produce one row; its unique violation maps to the stable code.
  begin
    insert into quiz_sessions (
      pairing_id, quiz_id, phase, scores, created_at, updated_at
    )
    values (
      v_pairing.id,
      p_quiz,
      'self_answer',
      jsonb_build_object(
        v_pairing.member_a::text, 0,
        v_pairing.member_b::text, 0
      ),
      v_now,
      v_now
    )
    returning * into v_session;
  exception when unique_violation then
    return query select 'QUIZ_SESSION_IN_PROGRESS'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end;

  return query select 'OK'::text, v_session.id, v_session.phase, v_session.scores;
end;
$$;

comment on function public.quiz_start_session (uuid, uuid, uuid, timestamptz) is
  'Atomically starts a quiz session for an active, linked pairing. The partial active-session unique index is translated to QUIZ_SESSION_IN_PROGRESS.';

revoke execute on function public.quiz_start_session (uuid, uuid, uuid, timestamptz)
  from public;
grant execute on function public.quiz_start_session (uuid, uuid, uuid, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- public.quiz_submit_self_answer
-- ---------------------------------------------------------------------------
create or replace function public.quiz_submit_self_answer (
  p_session uuid,
  p_actor   uuid,
  p_question uuid,
  p_answer  jsonb,
  p_now     timestamptz default now()
)
  returns table (
    result_code text,
    session_id  uuid,
    phase       quiz_phase,
    scores      jsonb
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing_id       uuid;
  v_pairing          pairings%rowtype;
  v_member_a_pairing uuid;
  v_member_b_pairing uuid;
  v_session          quiz_sessions%rowtype;
  v_question         quiz_questions%rowtype;
  v_now              timestamptz := coalesce(p_now, now());
begin
  -- Resolve the parent first, then lock parent before child.  This order is
  -- compatible with pairing dissolution and avoids an unlink/submission
  -- deadlock (dissolution locks pairings before session rows).
  select pairing_id into v_pairing_id
  from quiz_sessions
  where id = p_session;

  if not found then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
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
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  select pairing_id into v_member_a_pairing
  from accounts where id = v_pairing.member_a for share;
  select pairing_id into v_member_b_pairing
  from accounts where id = v_pairing.member_b for share;
  if v_member_a_pairing is distinct from v_pairing.id
     or v_member_b_pairing is distinct from v_pairing.id then
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- Serialize all answer submissions and the self_answer -> guessing gate.
  select * into v_session
  from quiz_sessions
  where id = p_session
  for update;

  if not found then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if v_session.pairing_id <> v_pairing.id then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if v_session.phase <> 'self_answer' then
    return query select 'WRONG_PHASE'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  select * into v_question
  from quiz_questions
  where id = p_question
    and quiz_id = v_session.quiz_id
  for share;

  if not found then
    return query select 'QUESTION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if exists (
    select 1 from quiz_self_answers sa
    where sa.session_id = v_session.id
      and sa.account_id = p_actor
      and sa.question_id = v_question.id
  ) then
    return query select 'ALREADY_ANSWERED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- SQL equivalent of core validateAnswer.  Guard jsonb shape before every
  -- dereference so malformed payloads return INVALID_ANSWER rather than SQL
  -- errors.
  if not coalesce(
    jsonb_typeof(p_answer) = 'object'
    and (
      (
        v_question.type = 'multiple_choice'
        and p_answer ->> 'kind' = 'choice'
        and jsonb_typeof(p_answer -> 'value') = 'string'
        and v_question.choices @> jsonb_build_array(p_answer -> 'value')
      )
      or (
        v_question.type = 'short_answer'
        and p_answer ->> 'kind' = 'text'
        and jsonb_typeof(p_answer -> 'value') = 'string'
        and char_length(p_answer ->> 'value') between 1 and 100
      )
    ),
    false
  ) then
    return query select 'INVALID_ANSWER'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  begin
    insert into quiz_self_answers (session_id, account_id, question_id, answer)
    values (v_session.id, p_actor, v_question.id, p_answer);
  exception when unique_violation then
    -- Covers a race with a legacy/direct writer as well as a retry that reached
    -- the primary key after this RPC's pre-check.
    return query select 'ALREADY_ANSWERED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end;

  -- Advance exactly when both linked partners have every question.  The locked
  -- session makes simultaneous final answers serialize, so the second one sees
  -- the first and performs the single phase transition.
  if not exists (
    select 1
    from quiz_questions q
    cross join (values (v_pairing.member_a), (v_pairing.member_b)) as partner(account_id)
    where q.quiz_id = v_session.quiz_id
      and not exists (
        select 1 from quiz_self_answers sa
        where sa.session_id = v_session.id
          and sa.account_id = partner.account_id
          and sa.question_id = q.id
      )
  ) then
    update quiz_sessions
    set phase = 'guessing', updated_at = v_now
    where quiz_sessions.id = v_session.id
    returning * into v_session;
  end if;

  return query select 'OK'::text, v_session.id, v_session.phase, v_session.scores;
end;
$$;

comment on function public.quiz_submit_self_answer (uuid, uuid, uuid, jsonb, timestamptz) is
  'Atomically validates and records one partner self-answer, then advances to guessing only after both linked partners answered every question.';

revoke execute on function public.quiz_submit_self_answer (uuid, uuid, uuid, jsonb, timestamptz)
  from public;
grant execute on function public.quiz_submit_self_answer (uuid, uuid, uuid, jsonb, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- public.quiz_submit_guess
-- ---------------------------------------------------------------------------
create or replace function public.quiz_submit_guess (
  p_session uuid,
  p_actor   uuid,
  p_question uuid,
  p_guess   jsonb,
  p_matched boolean,
  p_now     timestamptz default now()
)
  returns table (
    result_code text,
    session_id  uuid,
    phase       quiz_phase,
    scores      jsonb
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing_id       uuid;
  v_pairing          pairings%rowtype;
  v_member_a_pairing uuid;
  v_member_b_pairing uuid;
  v_session          quiz_sessions%rowtype;
  v_question         quiz_questions%rowtype;
  v_scores           jsonb;
  v_actor_score      integer;
  v_now              timestamptz := coalesce(p_now, now());
begin
  select pairing_id into v_pairing_id
  from quiz_sessions
  where id = p_session;

  if not found then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
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
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  select pairing_id into v_member_a_pairing
  from accounts where id = v_pairing.member_a for share;
  select pairing_id into v_member_b_pairing
  from accounts where id = v_pairing.member_b for share;
  if v_member_a_pairing is distinct from v_pairing.id
     or v_member_b_pairing is distinct from v_pairing.id then
    return query select 'PAIRING_REQUIRED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  -- Serialize scoring and the guessing -> complete gate with every other
  -- submission for this session.
  select * into v_session
  from quiz_sessions
  where id = p_session
  for update;

  if not found then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if v_session.pairing_id <> v_pairing.id then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if v_session.phase <> 'guessing' then
    return query select 'WRONG_PHASE'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  select * into v_question
  from quiz_questions
  where id = p_question
    and quiz_id = v_session.quiz_id
  for share;

  if not found then
    return query select 'QUESTION_NOT_FOUND'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if exists (
    select 1 from quiz_guesses g
    where g.session_id = v_session.id
      and g.account_id = p_actor
      and g.question_id = v_question.id
  ) then
    return query select 'ALREADY_GUESSED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  if not coalesce(
    jsonb_typeof(p_guess) = 'object'
    and (
      (
        v_question.type = 'multiple_choice'
        and p_guess ->> 'kind' = 'choice'
        and jsonb_typeof(p_guess -> 'value') = 'string'
        and v_question.choices @> jsonb_build_array(p_guess -> 'value')
      )
      or (
        v_question.type = 'short_answer'
        and p_guess ->> 'kind' = 'text'
        and jsonb_typeof(p_guess -> 'value') = 'string'
        and char_length(p_guess ->> 'value') between 1 and 100
      )
    ),
    false
  ) then
    return query select 'INVALID_GUESS'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end if;

  begin
    insert into quiz_guesses (session_id, account_id, question_id, guess)
    values (v_session.id, p_actor, v_question.id, p_guess);
  exception when unique_violation then
    return query select 'ALREADY_GUESSED'::text, null::uuid,
      null::quiz_phase, null::jsonb;
    return;
  end;

  v_scores := coalesce(v_session.scores, '{}'::jsonb);
  -- Sessions created by quiz_start_session always carry integer zeroes.  The
  -- defensive shape check keeps a malformed legacy score document from causing
  -- a cast exception; the actor simply resumes at zero in that corrupt case.
  v_actor_score := case
    when jsonb_typeof(v_scores -> p_actor::text) = 'number'
      and (v_scores ->> p_actor::text) ~ '^-?[0-9]{1,9}$'
      then (v_scores ->> p_actor::text)::integer
    else 0
  end;
  -- `p_matched` is computed by the trusted Edge Function with the exact shared
  -- core answersMatch implementation (including its Unicode behavior).  The
  -- locked score document is still incremented here, so concurrent correct
  -- guesses cannot overwrite one another's points.
  if coalesce(p_matched, false) then
    v_scores := jsonb_set(
      v_scores,
      array[p_actor::text],
      to_jsonb(v_actor_score + 1),
      true
    );
  end if;

  -- Update scores for every accepted guess (including a non-match, which
  -- preserves the score document) and atomically complete only when both
  -- partners have submitted every guess.
  update quiz_sessions
  set scores = v_scores,
      phase = case when not exists (
        select 1
        from quiz_questions q
        cross join (values (v_pairing.member_a), (v_pairing.member_b)) as partner(account_id)
        where q.quiz_id = v_session.quiz_id
          and not exists (
            select 1 from quiz_guesses g
            where g.session_id = v_session.id
              and g.account_id = partner.account_id
              and g.question_id = q.id
          )
      ) then 'complete'::quiz_phase else quiz_sessions.phase end,
      updated_at = v_now
  where quiz_sessions.id = v_session.id
  returning * into v_session;

  return query select 'OK'::text, v_session.id, v_session.phase, v_session.scores;
end;
$$;

comment on function public.quiz_submit_guess (uuid, uuid, uuid, jsonb, boolean, timestamptz) is
  'Atomically validates and records a guess, increments the guessing partner from the trusted core-derived match result, and completes only after both partners guessed every question.';

revoke execute on function public.quiz_submit_guess (uuid, uuid, uuid, jsonb, boolean, timestamptz)
  from public;
grant execute on function public.quiz_submit_guess (uuid, uuid, uuid, jsonb, boolean, timestamptz)
  to service_role;

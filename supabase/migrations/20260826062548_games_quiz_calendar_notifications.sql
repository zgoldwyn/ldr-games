-- Migration: real-time/async game sessions, quizzes, calendar dates, reminders,
--            and notifications
-- Feature: ldr-companion-app (task 2.2)
--
-- Encodes the game / quiz / calendar / notification data models from design.md.
-- Requirements: 6.2, 7.2, 8.2, 8.9, 8.11, 9.1, 10.1, 10.4, 11.4
--
-- Depends on migration 20260826062547_accounts_sessions_pairings.sql for the
-- `accounts` and `pairings` tables that these rows reference.
--
-- NOTE: Row Level Security policies are intentionally NOT defined here.
--       RLS enablement + policies (including the pairing-scope predicate and the
--       quiz self-answer withholding policy) live in a later migration (task 2.3).
--
-- Shared / pairing-owned rows carry an `hlc` (hybrid logical clock) column so the
-- write-path Edge Function can apply last-write-wins conflict resolution
-- (design "Data Models": HLCTimestamp = { physical, counter, originAccountId }).
-- Catalog data (`quiz_defs`, `quiz_questions`) and account-owned data
-- (`notifications`, `notification_settings`) are NOT pairing-synced and carry no hlc.

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

-- Real-time game session lifecycle (Req 6.x): pending -> active <-> paused,
-- and active/paused -> terminal.
create type rt_session_state as enum ('pending', 'active', 'paused', 'terminal');

-- Asynchronous game session lifecycle (Req 7.x): active until a terminal outcome
-- is recorded; sessions never expire from inactivity (Req 7.11).
create type async_session_state as enum ('active', 'terminal');

-- Quiz question kinds (design QuizQuestion).
create type quiz_question_type as enum ('multiple_choice', 'short_answer');

-- Two-phase quiz progression (Req 8.2, 8.5, 8.8): self_answer -> guessing -> complete.
create type quiz_phase as enum ('self_answer', 'guessing', 'complete');

-- Reminder lifecycle (Req 10.x): scheduled until delivered, or cancelled when its
-- parent date is deleted.
create type reminder_status as enum ('scheduled', 'cancelled', 'delivered');

-- Notification categories (design NotificationCategory, Req 11.3 per-category settings).
create type notification_category as enum (
  'pairing', 'game_invite', 'async_turn', 'reminder', 'quiz', 'system'
);

-- ---------------------------------------------------------------------------
-- rt_sessions (real-time game sessions)
-- ---------------------------------------------------------------------------
-- Pairing-scoped real-time game session. `game_state` is the Edge-Function
-- authoritative game-specific state. `pending_since` / `paused_since` back the
-- 60s join-window and 5-min resume-window pg_cron jobs (Req 6.9, 6.10).
create table rt_sessions (
  id            uuid primary key default gen_random_uuid (),
  pairing_id    uuid not null references pairings (id) on delete cascade,
  game_id       text not null,
  state         rt_session_state not null default 'pending',
  game_state    jsonb not null default '{}'::jsonb,
  outcome       jsonb,
  pending_since timestamptz,
  paused_since  timestamptz,
  hlc           jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table rt_sessions is
  'Pairing-scoped real-time game sessions (Req 6.x). game_state is Edge-Function authoritative.';
comment on column rt_sessions.pairing_id is
  'RLS predicate: must equal the requester''s current active pairing.';
comment on column rt_sessions.hlc is
  'Hybrid logical clock { physical, counter, originAccountId } for LWW conflict resolution.';

-- Fast lookup of a pairing's sessions.
create index rt_sessions_pairing_idx on rt_sessions (pairing_id);

-- ---------------------------------------------------------------------------
-- async_sessions (asynchronous / turn-based game sessions)
-- ---------------------------------------------------------------------------
-- Pairing-scoped durable turn-based session. `active_turn_holder` is the only
-- account permitted to take the next turn (Req 7.4); `turn_pending_since` drives
-- the 48h nudge pg_cron job (Req 7.12). Req 7.2: an initial holder is designated
-- at creation (holder is NOT NULL).
create table async_sessions (
  id                 uuid primary key default gen_random_uuid (),
  pairing_id         uuid not null references pairings (id) on delete cascade,
  game_id            text not null,
  state              async_session_state not null default 'active',
  active_turn_holder uuid not null references accounts (id) on delete cascade,
  turn_pending_since timestamptz not null default now(),
  game_state         jsonb not null default '{}'::jsonb,
  outcome            jsonb,
  hlc                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table async_sessions is
  'Pairing-scoped asynchronous turn-based game sessions (Req 7.x); never expire from inactivity.';
comment on column async_sessions.active_turn_holder is
  'The account whose turn it is; only this account may take the next turn (Req 7.4).';
comment on column async_sessions.turn_pending_since is
  'When the current turn became pending; drives the 48h nudge job (Req 7.12).';

create index async_sessions_pairing_idx on async_sessions (pairing_id);

-- ---------------------------------------------------------------------------
-- quiz_defs / quiz_questions (global quiz catalog)
-- ---------------------------------------------------------------------------
-- Quiz catalog is global (not pairing-scoped): a themed set of questions.
create table quiz_defs (
  id         uuid primary key default gen_random_uuid (),
  theme      text not null,
  created_at timestamptz not null default now()
);

comment on table quiz_defs is
  'Global quiz catalog: a themed collection of questions.';

-- Each question belongs to EXACTLY ONE quiz (Req 8.9). The single NOT NULL
-- foreign key `quiz_id` structurally enforces this: a question row references
-- one and only one quiz_defs row.
create table quiz_questions (
  id         uuid primary key default gen_random_uuid (),
  quiz_id    uuid not null references quiz_defs (id) on delete cascade,
  type       quiz_question_type not null,
  prompt     text not null,
  choices    jsonb,
  created_at timestamptz not null default now(),
  -- multiple_choice questions carry their offered choices; short_answer do not.
  constraint quiz_questions_choices_by_type check (
    (type = 'multiple_choice' and choices is not null)
    or (type = 'short_answer' and choices is null)
  )
);

comment on table quiz_questions is
  'Quiz questions; the NOT NULL quiz_id FK enforces one quiz per question (Req 8.9).';
comment on column quiz_questions.choices is
  'JSON array of offered choices for multiple_choice questions; null for short_answer.';

create index quiz_questions_quiz_idx on quiz_questions (quiz_id);

-- ---------------------------------------------------------------------------
-- quiz_sessions (per-pairing two-phase quiz run)
-- ---------------------------------------------------------------------------
-- A pairing plays a quiz in two phases: self_answer -> guessing -> complete
-- (Req 8.2, 8.5, 8.8). `scores` is an account_id -> points map (Req 8.7).
create table quiz_sessions (
  id         uuid primary key default gen_random_uuid (),
  pairing_id uuid not null references pairings (id) on delete cascade,
  quiz_id    uuid not null references quiz_defs (id),
  phase      quiz_phase not null default 'self_answer',
  scores     jsonb not null default '{}'::jsonb,
  hlc        jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table quiz_sessions is
  'Per-pairing two-phase quiz run (Req 8.2). phase gates self-answer visibility via RLS.';

-- At most ONE active (not-yet-complete) quiz session per pairing (Req 8.11).
-- A completed session no longer blocks starting a new one.
create unique index quiz_sessions_active_per_pairing_uidx
  on quiz_sessions (pairing_id) where phase <> 'complete';

-- ---------------------------------------------------------------------------
-- quiz_self_answers (withheld per phase by RLS)
-- ---------------------------------------------------------------------------
-- Each partner's own answers. Kept in a separate table so a dedicated RLS policy
-- (task 2.3) can make a partner's rows non-selectable while the parent session
-- is in the self_answer phase (Req 8.4), then reveal them in guessing/complete.
create table quiz_self_answers (
  session_id  uuid not null references quiz_sessions (id) on delete cascade,
  account_id  uuid not null references accounts (id) on delete cascade,
  question_id uuid not null references quiz_questions (id),
  answer      jsonb not null,
  hlc         jsonb,
  primary key (session_id, account_id, question_id)
);

comment on table quiz_self_answers is
  'Each partner''s self-answers; RLS withholds the partner''s rows during self_answer phase (Req 8.4).';
comment on column quiz_self_answers.answer is
  'Answer union { kind: "choice"|"text", value }; sensitive free-text may be field-encrypted.';

-- ---------------------------------------------------------------------------
-- quiz_guesses
-- ---------------------------------------------------------------------------
-- Each partner's guesses at the OTHER partner's self-answers (Req 8.6). One point
-- per matching guess is awarded by scoreSession (Req 8.7).
create table quiz_guesses (
  session_id  uuid not null references quiz_sessions (id) on delete cascade,
  account_id  uuid not null references accounts (id) on delete cascade,
  question_id uuid not null references quiz_questions (id),
  guess       jsonb not null,
  hlc         jsonb,
  primary key (session_id, account_id, question_id)
);

comment on table quiz_guesses is
  'Each partner''s guesses at the other partner''s self-answers (Req 8.6, scored per Req 8.7).';

-- ---------------------------------------------------------------------------
-- relationship_dates
-- ---------------------------------------------------------------------------
-- Pairing-scoped relationship dates (Req 9.1). Title is 1..100 non-whitespace
-- chars (Req 9.4); `date` is a valid calendar date (Req 9.5, enforced by the
-- `date` column type). `recurring` marks dates that reschedule reminders.
create table relationship_dates (
  id         uuid primary key default gen_random_uuid (),
  pairing_id uuid not null references pairings (id) on delete cascade,
  title      text not null,
  date       date not null,
  recurring  boolean not null default false,
  hlc        jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 1..100 chars after trimming surrounding whitespace (Req 9.4).
  constraint relationship_dates_title_len
    check (char_length(btrim(title)) between 1 and 100)
);

comment on table relationship_dates is
  'Pairing-scoped relationship dates (Req 9.1); title 1..100 non-whitespace chars (Req 9.4).';

create index relationship_dates_pairing_idx on relationship_dates (pairing_id);

-- ---------------------------------------------------------------------------
-- reminders (ON DELETE CASCADE from their date)
-- ---------------------------------------------------------------------------
-- Reminders for a relationship date. Deleting the parent date cascades and
-- removes its reminders so none remain scheduled to fire (Req 10.4). Lead time
-- is stored in seconds and constrained to 1 minute .. 365 days (Req 10.1).
-- `next_trigger_at` is scanned by the delivery pg_cron job (Req 10.3).
create table reminders (
  id                uuid primary key default gen_random_uuid (),
  date_id           uuid not null references relationship_dates (id) on delete cascade,
  pairing_id        uuid not null references pairings (id) on delete cascade,
  lead_time_seconds integer not null,
  next_trigger_at   timestamptz not null,
  status            reminder_status not null default 'scheduled',
  hlc               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Lead time 1 minute (60s) .. 365 days (31536000s) (Req 10.1).
  constraint reminders_lead_time_range
    check (lead_time_seconds between 60 and 31536000)
);

comment on table reminders is
  'Reminders for a relationship date; ON DELETE CASCADE cancels them with the date (Req 10.4).';
comment on column reminders.lead_time_seconds is
  'Lead time before the occurrence, 60s (1 min) .. 31536000s (365 days) (Req 10.1).';
comment on column reminders.next_trigger_at is
  'Next fire time; scanned by the delivery job (Req 10.3) and rescheduled for recurring dates (Req 10.5).';

-- pg_cron delivery job scans due, still-scheduled reminders.
create index reminders_due_idx on reminders (next_trigger_at) where status = 'scheduled';
create index reminders_date_idx on reminders (date_id);

-- ---------------------------------------------------------------------------
-- notifications (account/recipient-owned; survive unlinking)
-- ---------------------------------------------------------------------------
-- Durable notifications addressed to a single recipient account. Retained for up
-- to 30 days from `created_at` and delivered on next session (Req 11.4); a
-- pg_cron job discards rows older than 30 days (Req 11.5). `dedupe_key` suppresses
-- duplicate notifications; `acknowledged_at` suppresses re-delivery (Req 11.6).
create table notifications (
  id                   uuid primary key default gen_random_uuid (),
  recipient_account_id uuid not null references accounts (id) on delete cascade,
  category             notification_category not null,
  payload              jsonb not null default '{}'::jsonb,
  dedupe_key           text not null,
  acknowledged_at      timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz not null default now()
);

comment on table notifications is
  'Durable per-recipient notifications; 30-day retention (Req 11.4, 11.5). RLS: recipient-only.';
comment on column notifications.dedupe_key is
  'Suppresses duplicate notifications for the same recipient.';
comment on column notifications.acknowledged_at is
  'When acknowledged; suppresses re-delivery (Req 11.6).';

-- A given (recipient, dedupe_key) notification exists at most once (dedupe).
create unique index notifications_recipient_dedupe_uidx
  on notifications (recipient_account_id, dedupe_key);
-- Retrieval of a recipient's pending notifications within the retention window.
create index notifications_recipient_created_idx
  on notifications (recipient_account_id, created_at);

-- ---------------------------------------------------------------------------
-- notification_settings (per-account category preferences)
-- ---------------------------------------------------------------------------
-- One row per account. `disabled_categories` lists categories the account has
-- turned off (Req 11.3); shouldDeliver withholds those. `expo_push_token` holds
-- the mobile push registration for best-effort out-of-app delivery.
create table notification_settings (
  account_id          uuid primary key references accounts (id) on delete cascade,
  disabled_categories notification_category[] not null default '{}',
  expo_push_token     text,
  updated_at          timestamptz not null default now()
);

comment on table notification_settings is
  'Per-account notification preferences; disabled_categories withheld by shouldDeliver (Req 11.3).';

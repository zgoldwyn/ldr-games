-- Migration: accounts, single-session registry, lockout, invitations, and pairings
-- Feature: ldr-companion-app (task 2.1)
--
-- Encodes the account/session/pairing data models from design.md.
-- Requirements: 1.1, 2.3, 2.6, 2.7, 3.1, 3.6, 3.8
--
-- NOTE: Row Level Security policies are intentionally NOT defined here.
--       RLS enablement + policies live in a later migration (task 2.3).
--       Passwords are owned by Supabase Auth (bcrypt) and are NEVER stored
--       in application tables (Req 1.6).

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

-- Lifecycle of a pairing (Req 3.6, 4.x). 'active' membership is what the
-- exclusivity index below constrains; 'dissolved' rows are retained for history.
create type pairing_status as enum ('active', 'dissolved');

-- Lifecycle of a pairing invitation (Req 3.1, 3.5, 3.8).
--   pending  -> generated, within its 72h window, not yet used
--   consumed -> used exactly once to create a pairing (single-use, Req 3.8)
--   expired  -> passed its 72h validity window (Req 3.5) without being consumed
create type invitation_status as enum ('pending', 'consumed', 'expired');

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- One row per registered user, keyed 1:1 to auth.users. Email and the bcrypt
-- password hash are owned by Supabase Auth (auth.users) and are deliberately
-- absent here (Req 1.6). `pairing_id` is the RLS predicate for pairing-owned
-- data and points at the account's single active pairing (Req 3.6).
create table accounts (
  id         uuid primary key references auth.users (id) on delete cascade,
  -- pairing_id FK is added after `pairings` exists (circular dependency).
  pairing_id uuid,
  created_at timestamptz not null default now()
);

comment on table accounts is
  'Application account, 1:1 with auth.users. Email/password live in Supabase Auth (Req 1.6).';
comment on column accounts.pairing_id is
  'Current active pairing for this account (null = unpaired). RLS predicate for pairing-owned data.';

-- ---------------------------------------------------------------------------
-- account_session (single-session epoch registry)
-- ---------------------------------------------------------------------------
-- Exactly one row per account. `epoch` increments on every new login; a token
-- whose epoch does not match the current epoch is stale and denied, which is
-- what enforces "only the newest client retains access" (Req 2.7, 2.8).
-- `last_activity_at` backs the 30-day inactivity expiry (Req 2.6).
create table account_session (
  account_id       uuid primary key references accounts (id) on delete cascade,
  epoch            integer     not null default 0,
  client           jsonb       not null default '{}'::jsonb, -- ClientInfo: platform, device
  last_activity_at timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table account_session is
  'Single-session registry. Current epoch per account; stale-epoch tokens are rejected (Req 2.7-2.9).';
comment on column account_session.epoch is
  'Increments on each new login; token epoch claim must equal this value.';
comment on column account_session.last_activity_at is
  'Drives the 30-day inactivity session expiry (Req 2.6).';

-- ---------------------------------------------------------------------------
-- auth_attempts (lockout tracking)
-- ---------------------------------------------------------------------------
-- Tracks consecutive failed sign-in attempts per account within a rolling
-- window. 5 failures within 15 minutes sets `locked_until` = now + 15 min
-- (Req 2.3). Reset on successful login.
create table auth_attempts (
  account_id   uuid primary key references accounts (id) on delete cascade,
  failed_count integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);

comment on table auth_attempts is
  'Consecutive failed-login tracking for the 5-in-15-minutes lockout (Req 2.3).';
comment on column auth_attempts.locked_until is
  'When set and in the future, authentication for this account is temporarily locked.';

-- ---------------------------------------------------------------------------
-- pairings
-- ---------------------------------------------------------------------------
-- An exclusive one-to-one link between two accounts. member_a/member_b match
-- the Pairing row shape in design.md. Exclusivity (Req 3.6) is enforced by the
-- partial UNIQUE indexes below: an account may appear in at most one ACTIVE
-- pairing per member column. The acceptInvitation transaction (task 13.1)
-- additionally guards the cross-column case via accounts.pairing_id.
create table pairings (
  id           uuid primary key default gen_random_uuid (),
  member_a     uuid not null references accounts (id) on delete cascade,
  member_b     uuid not null references accounts (id) on delete cascade,
  status       pairing_status not null default 'active',
  created_at   timestamptz not null default now(),
  dissolved_at timestamptz,
  constraint pairings_distinct_members check (member_a <> member_b)
);

comment on table pairings is
  'Exclusive 1:1 link between two accounts (Req 3.2, 3.6, 4.x).';

-- Each account is in at most one ACTIVE pairing (Req 3.6). One partial UNIQUE
-- index per member column; combined with the acceptInvitation transaction this
-- prevents any account from being in two active pairings simultaneously.
create unique index pairings_member_a_active_uidx
  on pairings (member_a) where status = 'active';
create unique index pairings_member_b_active_uidx
  on pairings (member_b) where status = 'active';

-- Now that pairings exists, wire the accounts -> pairings FK. ON DELETE SET NULL
-- so removing a pairing row leaves the account intact but unpaired.
alter table accounts
  add constraint accounts_pairing_id_fkey
  foreign key (pairing_id) references pairings (id) on delete set null;

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
-- A time-limited, single-use request to form a pairing. `code` is the unique
-- shareable token. Valid for 72h from creation (Req 3.1); `status` enforces
-- single-use consumption (Req 3.8) and expiry (Req 3.5).
create table invitations (
  id                 uuid primary key default gen_random_uuid (),
  code               text not null unique,
  inviter_account_id uuid not null references accounts (id) on delete cascade,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '72 hours'),
  status             invitation_status not null default 'pending',
  consumed_at        timestamptz,
  constraint invitations_expiry_after_creation check (expires_at > created_at)
);

comment on table invitations is
  'Time-limited (72h, Req 3.1), single-use (Req 3.8) pairing invitations.';
comment on column invitations.code is
  'Unique shareable invitation token.';
comment on column invitations.expires_at is
  'Creation time + 72 hours (Req 3.1); acceptance after this is rejected (Req 3.5).';

-- Lookup by inviter (e.g. "does this account already have a pending invite?").
create index invitations_inviter_idx on invitations (inviter_account_id);

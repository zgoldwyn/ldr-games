-- Feature: ldr-companion-app (fixes a defect in task 2.3)
--
-- Grants the `service_role` DML on the application tables.
--
-- THE BUG
-- -------
-- Migration 20260826062549 states the enforcement model as:
--
--   "Server-authoritative transitions ... run in Edge Functions using the
--    `service_role`, which has BYPASSRLS."
--
-- That is only half of what `service_role` needs. BYPASSRLS exempts the role
-- from ROW-level policies, but row-level policies are only consulted after
-- TABLE-level privileges are satisfied. `service_role` had no DML privileges on
-- these tables at all, so every server-authoritative write failed with
--
--   permission denied for table <name>
--
-- before RLS was ever reached.
--
-- WHY THE USUAL DEFAULT DID NOT COVER IT
-- --------------------------------------
-- On a stock Supabase project `service_role` gets full DML from
-- `ALTER DEFAULT PRIVILEGES`. There are two such entries for schema `public`,
-- and which one applies depends on who owns the new table:
--
--   owner supabase_admin -> {anon,authenticated,service_role} = arwdDxtm  (all)
--   owner postgres       -> {anon,authenticated,service_role} = Dxtm      (no DML)
--
-- These tables are owned by `postgres` (migrations run as `postgres`), so the
-- second, DML-less entry applied: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN but
-- no SELECT / INSERT / UPDATE / DELETE. Migration 20260826062549 then granted DML
-- explicitly to `authenticated` on each table and never to `service_role`, so
-- the gap went unnoticed -- client reads worked, and nothing had yet executed a
-- server-authoritative write against a live database.
--
-- WHAT THIS DOES
-- --------------
-- Restores the intended privileges for `service_role` only. `anon` and
-- `authenticated` are deliberately untouched: the narrow, per-table grants in
-- 20260826062549 are load-bearing, since RLS is the primary authorization
-- mechanism for clients and `anon` is meant to hold nothing on these tables.
--
-- Granted schema-wide rather than table-by-table on purpose. Enumerating tables
-- per role is exactly what produced this defect; a schema-wide grant cannot omit
-- one. The matching ALTER DEFAULT PRIVILEGES keeps a table added by a future
-- migration from reintroducing the same gap.

-- ===========================================================================
-- Existing tables
-- ===========================================================================

grant select, insert, update, delete on all tables in schema public
  to service_role;

-- ===========================================================================
-- Future tables
-- ===========================================================================
-- Scoped to `postgres` as the granting role, matching the owner that migrations
-- create tables as -- that is the default-privileges entry which was missing DML.

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;

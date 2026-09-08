-- Migration: epoch-guard account-owned notification settings
-- Feature: ldr-companion-app (task 19.1b)
--
-- A notification-settings row belongs to one account, but the client must not
-- write it directly: all shared-data mutations go through sync-write, where
-- the caller's account and HLC are validated server-side. A token issued
-- before a newer login must not be able to change preferences either. Keep a
-- self+epoch SELECT policy for reads, and remove the direct authenticated write
-- surface entirely.

drop policy if exists notification_settings_select_self on notification_settings;
drop policy if exists notification_settings_insert_self on notification_settings;
drop policy if exists notification_settings_update_self on notification_settings;

revoke insert, update on notification_settings from authenticated;

create policy notification_settings_select_self on notification_settings
  for select to authenticated
  using (
    account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  );

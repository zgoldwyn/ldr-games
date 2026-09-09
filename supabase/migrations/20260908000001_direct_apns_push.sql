-- Feature: ldr-companion-app (task 22.1c)
--
-- The iOS shell obtains Apple's native device token and the notification
-- webhook sends directly to APNs. Expo's hosted push gateway is not involved.

alter table public.notification_settings
  rename column expo_push_token to apns_device_token;

-- Existing values, if any, are Expo gateway tokens and cannot be sent to APNs.
update public.notification_settings
   set apns_device_token = null
 where apns_device_token is not null;

alter table public.notification_settings
  add column apns_environment text;

alter table public.notification_settings
  add constraint notification_settings_apns_environment_chk
  check (apns_environment is null or apns_environment in ('development', 'production'));

alter table public.notification_settings
  add constraint notification_settings_apns_token_chk
  check (apns_device_token is null or apns_device_token ~ '^([0-9A-Fa-f]{2})+$');

alter table public.notification_settings
  add constraint notification_settings_apns_pair_chk
  check (
    (apns_device_token is null and apns_environment is null)
    or
    (apns_device_token is not null and apns_environment is not null)
  );

comment on column public.notification_settings.apns_device_token is
  'Native Apple Push Notification service device token for direct iOS delivery.';

comment on column public.notification_settings.apns_environment is
  'APNs endpoint for the token: development (sandbox) or production.';

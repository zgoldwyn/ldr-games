-- Friendly display names shared only with the account's current partner.
create table public.account_profiles (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  display_name text not null,
  updated_at timestamptz not null default now(),
  constraint account_profiles_display_name_check check (
    display_name = btrim(display_name)
    and char_length(display_name) between 1 and 40
    and display_name !~ E'[\\n\\r]'
  )
);

comment on table public.account_profiles is
  'A user-controlled display name visible only to that user and their current partner.';

alter table public.account_profiles enable row level security;
grant select, insert, update on public.account_profiles to authenticated;

create or replace function app.is_self_or_current_partner(profile_account_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select profile_account_id = auth.uid()
    or exists (
      select 1
      from public.pairings p
      where p.id = app.current_pairing(auth.uid())
        and p.status = 'active'
        and profile_account_id in (p.member_a, p.member_b)
    );
$$;

grant execute on function app.is_self_or_current_partner(uuid) to authenticated, service_role;

create policy account_profiles_select_self_or_partner on public.account_profiles
  for select to authenticated
  using (
    app.session_epoch_ok(auth.uid())
    and app.is_self_or_current_partner(account_id)
  );

create policy account_profiles_insert_self on public.account_profiles
  for insert to authenticated
  with check (
    account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  );

create policy account_profiles_update_self on public.account_profiles
  for update to authenticated
  using (
    account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  )
  with check (
    account_id = auth.uid()
    and app.session_epoch_ok(auth.uid())
  );

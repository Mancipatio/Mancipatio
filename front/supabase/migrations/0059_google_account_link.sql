-- A signed-in (email) account can connect Google through the sign-in flow:
-- the state remembers which account asked, so the callback links instead of
-- signing in.
begin;
alter table public.auth_google_states add column link_account_id uuid references public.account_profiles(id) on delete cascade;
create or replace function public.link_account_google_by_id(p_account_id uuid, p_network text, p_sub text, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare other uuid;
begin
  if p_sub is null or length(p_sub) not between 1 and 255 or length(p_email) not between 3 and 254 then return 'invalid'; end if;
  perform 1 from public.account_profiles where id = p_account_id and network = p_network for update;
  if not found then return 'invalid'; end if;
  select id into other from public.account_profiles where network = p_network and google_sub = p_sub and id <> p_account_id;
  if other is not null then return 'google_in_use'; end if;
  update public.account_profiles set google_sub = p_sub, google_email = lower(p_email), google_linked_at = clock_timestamp() where id = p_account_id;
  return 'linked';
end $$;
revoke all on function public.link_account_google_by_id(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.link_account_google_by_id(uuid,text,text,text) to service_role;
commit;

-- Storm Exchange: terms/age agreement, prize eligibility and the admin Epic-name tool (run once in the Supabase SQL
-- Editor). Safe to re-run. The same changes are in schema.sql.

alter table public.profiles add column if not exists agreed_at   timestamptz;   -- 13+ and agreed to Terms + Privacy
alter table public.profiles add column if not exists prize_ok_at timestamptz;   -- 18+ (or guardian OK) + Prize Rules

-- New accounts must confirm they're 13 or older and agree to the Terms of Service and Privacy Policy.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare u text := trim(coalesce(new.raw_user_meta_data->>'username', ''));
begin
  if u !~ '^[A-Za-z0-9_.-]{3,16}$' then
    raise exception 'Usernames are 3-16 letters, numbers, dots, dashes or underscores.';
  end if;
  if coalesce(new.raw_user_meta_data->>'agreed', '') <> 'true' then
    raise exception 'Please confirm you are 13 or older and agree to the Terms of Service and Privacy Policy.';
  end if;
  insert into public.profiles (id, username, agreed_at) values (new.id, u, now());
  return new;
exception when unique_violation then
  raise exception 'That username is taken.';
end $$;

-- Accounts made before the Terms existed agree once, from the site.
create or replace function public.accept_terms() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  update public.profiles set agreed_at = coalesce(agreed_at, now()) where id = auth.uid();
end $$;

-- Prize eligibility: the trader confirms they're 18+ (or have a parent/guardian's permission) and accept the Prize Rules.
create or replace function public.confirm_prize_eligibility() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  update public.profiles set prize_ok_at = coalesce(prize_ok_at, now()) where id = auth.uid() and agreed_at is not null;
  if not found then raise exception 'Please accept the Terms of Service first.'; end if;
end $$;

-- Admins fix a player's Epic display name (used to match tournament results); the next refresh picks it up.
create or replace function public.admin_set_epic(p_player text, p_epic text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_epic is null or length(trim(p_epic)) not between 3 and 32 then raise exception 'Epic names are 3-32 characters.'; end if;
  update public.players set epic = trim(p_epic) where id = p_player;
  if not found then raise exception 'No such player.'; end if;
end $$;

revoke all on function public.accept_terms() from public, anon;
revoke all on function public.confirm_prize_eligibility() from public, anon;
revoke all on function public.admin_set_epic(text, text) from public, anon;
grant execute on function public.accept_terms() to authenticated;
grant execute on function public.confirm_prize_eligibility() to authenticated;
grant execute on function public.admin_set_epic(text, text) to authenticated;

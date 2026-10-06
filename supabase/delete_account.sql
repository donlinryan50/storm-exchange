-- Storm Exchange: let a signed-in trader delete their own account (run once in the Supabase SQL Editor; safe to
-- re-run). The same function is in schema.sql.
--
-- Their open positions are taken off the market first (so prices no longer include bets nobody holds), then the
-- sign-in account is deleted, which removes their profile, portfolios, positions and trades (on delete cascade).
create or replace function public.delete_my_account(p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  uname text;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  select username into uname from public.profiles where id = uid;
  if uname is null or lower(trim(coalesce(p_confirm, ''))) <> lower(uname) then
    raise exception 'Type your username exactly to confirm.';
  end if;
  update public.market m
     set net = m.net - case when x.side = 'long' then x.shares else -x.shares end
    from public.positions x
   where x.user_id = uid and m.season = x.season and m.player_id = x.player_id;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

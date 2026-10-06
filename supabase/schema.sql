-- Storm Exchange: Supabase schema, security rules and server-side game logic.
-- Run this whole file once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to re-run: everything is "create ... if not exists" / "create or replace".
--
-- Security model
--   * Everyone (even signed out) can READ the market: players, prices, trades, leaderboard.
--   * Nobody can WRITE game tables directly. Trades go through trade(), a server function that
--     prices the order, checks gold bars and the 40% cap, and updates everything in one transaction.
--   * Each player can only change their own profile, and only through the functions below.
--   * Tournament data, PR, seasons and Div Cup price moves are written by the refresh job with the
--     service-role key (never shipped to browsers) or by admins through admin_* functions.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  username         extensions.citext not null unique
                     check (username ~ '^[A-Za-z0-9_.-]{3,16}$'),
  discord_id       text unique,
  discord_username text,
  discord_avatar   text,
  agreed_at        timestamptz,                         -- 13+ and agreed to Terms + Privacy
  prize_ok_at      timestamptz,                         -- 18+ (or guardian OK) + Prize Rules
  created_at       timestamptz not null default now()
);
alter table public.profiles add column if not exists agreed_at   timestamptz;
alter table public.profiles add column if not exists prize_ok_at timestamptz;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.players (
  id         text primary key,
  name       text not null check (length(name) between 1 and 40),
  region     text not null,
  pr         integer not null default 0,
  open       integer not null check (open > 0),          -- base IPO price (PR / 100)
  note       text,                                       -- team
  listed     date not null default current_date,
  epic       text,                                       -- Epic name, used by the stats scraper
  pr_history jsonb not null default '[]',                -- [{t:'YYYY-MM-DD', pr}]
  form       jsonb,                                      -- tournament results this season
  active     boolean not null default true
);

create table if not exists public.seasons (
  n        integer primary key,
  name     text not null,
  start_at timestamptz not null,
  end_at   timestamptz not null,
  depth    numeric not null default 250000,             -- ~1% price move per depth/100 gold bars
  ipo      jsonb not null default '{}',                 -- {player_id: open price this season}
  past     jsonb not null default '[]'                  -- archived champions
);

create table if not exists public.market (
  season    integer not null references public.seasons(n),
  player_id text not null references public.players(id),
  net       integer not null default 0,                 -- long shares minus short shares, everyone
  mult      numeric not null default 1,                 -- product of Div Cup price moves
  primary key (season, player_id)
);

create table if not exists public.portfolios (
  user_id uuid not null references public.profiles(id) on delete cascade,
  season  integer not null references public.seasons(n),
  cash    numeric not null default 25000 check (cash >= 0),
  trades  integer not null default 0,
  primary key (user_id, season)
);

create table if not exists public.positions (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  season    integer not null,
  player_id text not null references public.players(id),
  side      text not null check (side in ('long', 'short')),
  shares    integer not null check (shares > 0),
  avg       numeric not null check (avg > 0),
  primary key (user_id, season, player_id)
);

create table if not exists public.trades (
  id        bigserial primary key,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  season    integer not null,
  player_id text not null references public.players(id),
  action    text not null check (action in ('buy', 'sell', 'short', 'cover')),
  shares    integer not null check (shares > 0),
  price     numeric not null,                            -- average fill price per share
  net_after integer not null,                            -- market net shares after this trade
  mult      numeric not null,
  at        timestamptz not null default now()
);
create index if not exists trades_season_player_at on public.trades (season, player_id, at);
create index if not exists trades_user_at on public.trades (user_id, at);

create table if not exists public.shocks (
  id        bigserial primary key,
  season    integer not null,
  player_id text not null references public.players(id),
  factor    numeric not null check (factor > 0.5 and factor < 2),
  window_id text,
  region    text,
  kind      text check (kind in ('top', 'bad')),
  why       text,
  at        timestamptz not null default now()
);
create index if not exists shocks_season_at on public.shocks (season, at);

create table if not exists public.prsnaps (
  id   text primary key,
  at   timestamptz not null,
  pr   jsonb not null,
  note jsonb not null default '{}'
);

create table if not exists public.site_meta (           -- events schedule, Discord settings, sim data, stats time
  key   text primary key,
  value jsonb not null
);

create table if not exists public.login_attempts (
  username extensions.citext not null,
  at       timestamptz not null default now()
);
create index if not exists login_attempts_user_at on public.login_attempts (username, at);

-- ---------------------------------------------------------------------------------------------
-- Row-level security: read-only for clients; all writes go through the functions below
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','admins','players','seasons','market','portfolios','positions',
                           'trades','shocks','prsnaps','site_meta','login_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['profiles','players','seasons','market','portfolios','positions','trades',
                           'shocks','prsnaps','site_meta'] loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
end $$;
-- admins and login_attempts: no policies at all, so clients can't read or write them.

-- Realtime: let browsers subscribe to live market changes.
do $$
declare t text;
begin
  foreach t in array array['market','trades','shocks','portfolios','positions','players','site_meta','seasons'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; when undefined_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.current_season() returns public.seasons
language sql stable security definer set search_path = public as $$
  select * from public.seasons where start_at <= now() order by n desc limit 1;
$$;

-- Price of one share at net position n (same formula the site shows):
--   price = mult * open / (1 - n * open / depth)
create or replace function public.price_at(p_open numeric, p_net numeric, p_mult numeric, p_depth numeric)
returns numeric language sql immutable as $$
  select p_mult * p_open / greatest(1e-6, 1 - p_net * p_open / p_depth);
$$;

-- Gold bars to move net shares from n to n+k (integral of the price curve).
create or replace function public.fill_cost(p_open numeric, p_net numeric, p_k numeric, p_mult numeric, p_depth numeric)
returns numeric language plpgsql immutable as $$
declare a numeric := p_open / p_depth; hi numeric := 1 - (p_net + p_k) * a;
begin
  if hi <= 0 or 1 - p_net * a <= 0 then return null; end if;
  return p_mult * p_depth * ln((1 - p_net * a) / hi);
end $$;

-- What a position is actually worth: the gold bars you'd get by closing it right now. Valuing at the last
-- price instead would let a trader inflate their own net worth just by buying (their buying moves the price).
--   long:  proceeds of selling all shares (net -> net - shares)
--   short: 2 x avg x shares minus the cost of buying them back (net -> net + shares), never below 0
create or replace function public.liq_value(p_open numeric, p_net numeric, p_mult numeric, p_depth numeric,
                                            p_side text, p_shares numeric, p_avg numeric)
returns numeric language sql immutable as $$
  select case when p_side = 'long' then coalesce(public.fill_cost(p_open, p_net - p_shares, p_shares, p_mult, p_depth), 0)
              else greatest(0, 2 * p_avg * p_shares - coalesce(public.fill_cost(p_open, p_net, p_shares, p_mult, p_depth), 2 * p_avg * p_shares)) end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounts: sign-up creates a profile with the chosen username (validated, unique)
-- ---------------------------------------------------------------------------------------------
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_username ~ '^[A-Za-z0-9_.-]{3,16}$'
     and not exists (select 1 from public.profiles where username = p_username::extensions.citext);
$$;

-- Log in with a USERNAME: checks the password server-side and only then returns the account email,
-- which the browser passes to Supabase Auth. Wrong passwords never reveal the email, and 5 failed
-- attempts lock that username for 15 minutes (on top of Supabase Auth's own rate limits).
create or replace function public.login_email(p_login text, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; em text; hash text; fails integer;
begin
  if p_login is null or p_password is null or length(p_login) > 64 or length(p_password) > 200 then return null; end if;
  select count(*) into fails from public.login_attempts
   where username = p_login::citext and at > now() - interval '15 minutes';
  if fails >= 5 then raise exception 'Too many attempts. Try again in 15 minutes.'; end if;
  select p.id into uid from public.profiles p where p.username = p_login::citext;
  if uid is not null then
    select u.email, u.encrypted_password into em, hash from auth.users u where u.id = uid;
    if hash is not null and extensions.crypt(p_password, hash) = hash then
      delete from public.login_attempts where username = p_login::citext;
      return em;
    end if;
  end if;
  insert into public.login_attempts (username) values (p_login::citext);
  delete from public.login_attempts where at < now() - interval '1 day';
  return null;
end $$;

-- After "Link Discord" (Supabase identity linking), copy the VERIFIED Discord identity into the profile.
create or replace function public.sync_discord() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare idn jsonb; pid text; prof public.profiles;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select i.identity_data, i.provider_id into idn, pid
    from auth.identities i where i.user_id = auth.uid() and i.provider = 'discord'
    order by i.created_at desc limit 1;
  update public.profiles set
    discord_id       = case when idn is null then null else coalesce(pid, idn->>'sub', idn->>'provider_id') end,
    discord_username = case when idn is null then null else coalesce(idn->'custom_claims'->>'global_name', idn->>'full_name', idn->>'name', idn->>'user_name') end,
    discord_avatar   = case when idn is null then null else idn->>'avatar_url' end
  where id = auth.uid() returning * into prof;
  return prof;
exception when unique_violation then
  raise exception 'That Discord account is already linked to another Storm Exchange account.';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Trading: the only way to change cash, positions or prices
-- ---------------------------------------------------------------------------------------------
-- Market hours: trading on a region's players closes while one of its tournament rounds is being played. The refresh
-- job keeps site_meta 'closures' = {windows: [{w, name, r (NA|EU), b, e, moves}]} from Osirion's official schedule.
-- A round closes the region from its start until 2 hours after its scheduled end; a round that moves prices stays
-- closed until its price moves are posted (site_meta 'shocks_done'), with a 12-hour cap in case the job is down.
-- Returns the name of the round that has the region closed, or null if it's open.
create or replace function public.market_closed(p_region text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(w->>'name', w->>'w')
    from jsonb_array_elements(coalesce((select value->'windows' from public.site_meta where key = 'closures'), '[]'::jsonb)) w
   where w->>'r' = p_region
     and now() >= (w->>'b')::timestamptz
     and (now() < (w->>'e')::timestamptz + interval '2 hours'
          or (coalesce((w->>'moves')::boolean, false)
              and now() < (w->>'e')::timestamptz + interval '12 hours'
              and not coalesce((select value->'done' from public.site_meta where key = 'shocks_done') ? (w->>'w'), false)))
   order by (w->>'b')::timestamptz
   limit 1
$$;

create or replace function public.trade(p_player text, p_action text, p_shares integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  s public.seasons;
  pl public.players;
  m public.market;
  pf public.portfolios;
  pos public.positions;
  o numeric; total numeric; side text; new_net integer; nw numeric; val_after numeric; price_after numeric;
  last_at timestamptz;
  closed_ev text;
begin
  if uid is null then raise exception 'Sign in to trade.'; end if;
  if p_action not in ('buy', 'sell', 'short', 'cover') then raise exception 'Unknown trade.'; end if;
  if p_shares is null or p_shares < 1 or p_shares > 500 then raise exception 'Trade between 1 and 500 shares at a time.'; end if;
  s := public.current_season();
  if s.n is null then raise exception 'No season is running.'; end if;
  if now() > s.end_at then raise exception '% has ended. Trading reopens when the next season starts.', s.name; end if;
  select * into pl from public.players where id = p_player and active;
  if pl.id is null then raise exception 'That player is no longer listed.'; end if;
  closed_ev := public.market_closed(pl.region);
  if closed_ev is not null then
    raise exception 'Trading on % players is closed while % is being played. It reopens once the results are in.', pl.region, closed_ev;
  end if;

  insert into public.portfolios (user_id, season) values (uid, s.n) on conflict do nothing;
  select * into pf from public.portfolios where user_id = uid and season = s.n for update;
  if pf.trades >= 3000 then raise exception 'You have hit this season''s limit of 3,000 trades.'; end if;
  select max(at) into last_at from public.trades where user_id = uid;
  if last_at > now() - interval '400 milliseconds' then raise exception 'Slow down a little: one trade at a time.'; end if;

  insert into public.market (season, player_id) values (s.n, p_player) on conflict do nothing;
  select * into m from public.market where season = s.n and player_id = p_player for update;
  select * into pos from public.positions where user_id = uid and season = s.n and player_id = p_player for update;
  o := coalesce((s.ipo->>p_player)::numeric, pl.open);

  if p_action in ('buy', 'short') then
    side := case when p_action = 'buy' then 'long' else 'short' end;
    if pos.side is not null and pos.side <> side then
      raise exception '%', case when side = 'long' then 'Cover your short on ' || pl.name || ' before betting up.'
                                 else 'Sell your shares of ' || pl.name || ' before betting down.' end;
    end if;
    total := case when p_action = 'buy' then public.fill_cost(o, m.net, p_shares, m.mult, s.depth)
                  else public.fill_cost(o, m.net - p_shares, p_shares, m.mult, s.depth) end;
    if total is null then raise exception 'That order is too big for the market right now.'; end if;
    if total > pf.cash then raise exception 'Not enough gold bars. You have %.', round(pf.cash); end if;
    new_net := m.net + case when p_action = 'buy' then p_shares else -p_shares end;
    price_after := public.price_at(o, new_net, m.mult, s.depth);
    -- 40% cap: this position can't be more than 40% of net worth after the trade (both at liquidation value)
    select coalesce(sum(public.liq_value(coalesce((s.ipo->>x.player_id)::numeric, p2.open), coalesce(mk.net, 0), coalesce(mk.mult, 1), s.depth, x.side, x.shares, x.avg)), 0)
      into nw
      from public.positions x join public.players p2 on p2.id = x.player_id
      left join public.market mk on mk.season = s.n and mk.player_id = x.player_id
     where x.user_id = uid and x.season = s.n and x.player_id <> p_player;
    declare sh integer := coalesce(pos.shares, 0) + p_shares; av numeric := (coalesce(pos.shares * pos.avg, 0) + total) / (coalesce(pos.shares, 0) + p_shares);
    begin
      val_after := public.liq_value(o, new_net, m.mult, s.depth, side, sh, av);
      nw := nw + (pf.cash - total) + val_after;
      if val_after > 0.4 * nw + 1e-6 then raise exception 'That would put more than 40%% of your net worth into %.', pl.name; end if;
      insert into public.positions (user_id, season, player_id, side, shares, avg) values (uid, s.n, p_player, side, sh, av)
        on conflict (user_id, season, player_id) do update set shares = excluded.shares, avg = excluded.avg;
    end;
    update public.portfolios set cash = cash - total, trades = trades + 1 where user_id = uid and season = s.n;
  else
    if pos.side is null or pos.side <> (case when p_action = 'sell' then 'long' else 'short' end) then
      raise exception 'You don''t hold that position in %.', pl.name;
    end if;
    if p_shares > pos.shares then raise exception 'You only hold % shares.', pos.shares; end if;
    total := case when p_action = 'sell' then public.fill_cost(o, m.net - p_shares, p_shares, m.mult, s.depth)
                  else public.fill_cost(o, m.net, p_shares, m.mult, s.depth) end;
    if total is null then raise exception 'That order is too big for the market right now.'; end if;
    new_net := m.net + case when p_action = 'cover' then p_shares else -p_shares end;
    update public.portfolios set cash = cash + case when p_action = 'sell' then total else greatest(0, 2 * pos.avg * p_shares - total) end,
                                 trades = trades + 1
     where user_id = uid and season = s.n;
    if pos.shares = p_shares then delete from public.positions where user_id = uid and season = s.n and player_id = p_player;
    else update public.positions set shares = shares - p_shares where user_id = uid and season = s.n and player_id = p_player; end if;
  end if;

  update public.market set net = new_net where season = s.n and player_id = p_player;
  insert into public.trades (user_id, season, player_id, action, shares, price, net_after, mult)
    values (uid, s.n, p_player, p_action, p_shares, total / p_shares, new_net, m.mult);
  return jsonb_build_object('total', round(total, 2), 'price', round(public.price_at(o, new_net, m.mult, s.depth), 2), 'net', new_net);
end $$;

-- Div Cup price moves (inserted by the refresh job) multiply the player's price from now on.
create or replace function public.apply_shock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.market (season, player_id) values (new.season, new.player_id) on conflict do nothing;
  update public.market set mult = mult * new.factor where season = new.season and player_id = new.player_id;
  return new;
end $$;
drop trigger if exists on_shock on public.shocks;
create trigger on_shock after insert on public.shocks for each row execute function public.apply_shock();

-- ---------------------------------------------------------------------------------------------
-- Leaderboard (computed server-side from real positions and prices)
-- ---------------------------------------------------------------------------------------------
create or replace view public.leaderboard with (security_invoker = true) as
with s as (select * from public.current_season()),
vals as (
  select x.user_id,
         sum(public.liq_value(coalesce((s.ipo->>x.player_id)::numeric, p.open), coalesce(m.net, 0), coalesce(m.mult, 1), s.depth, x.side, x.shares, x.avg)) as held
    from public.positions x cross join s
    join public.players p on p.id = x.player_id
    left join public.market m on m.season = s.n and m.player_id = x.player_id
   where x.season = s.n
   group by x.user_id
)
select pf.user_id, pr.username, pr.discord_username, pr.discord_avatar, (pr.discord_id is not null) as prize_eligible,
       pf.cash + coalesce(v.held, 0) as net_worth, pf.trades
  from public.portfolios pf cross join s
  join public.profiles pr on pr.id = pf.user_id
  left join vals v on v.user_id = pf.user_id
 where pf.season = s.n;

-- ---------------------------------------------------------------------------------------------
-- Admin tools (owner only: add yourself with  insert into admins values ('<your user id>');)
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_set_meta(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_key not in ('discord', 'events') then raise exception 'Unknown setting.'; end if;
  insert into public.site_meta (key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value;
end $$;

create or replace function public.admin_set_season_end(p_end timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.seasons set end_at = p_end where n = (public.current_season()).n;
end $$;

create or replace function public.admin_add_player(p_id text, p_name text, p_region text, p_pr integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_id !~ '^[a-z0-9-]{1,40}$' or p_pr < 100 or p_pr > 1000000 then raise exception 'Check the player details.'; end if;
  insert into public.players (id, name, region, pr, open, pr_history)
  values (p_id, p_name, p_region, p_pr, round(p_pr / 100.0), jsonb_build_array(jsonb_build_object('t', current_date, 'pr', p_pr)));
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

-- A trader deletes their own account: open positions come off the market, then the sign-in account (cascades).
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

-- ---------------------------------------------------------------------------------------------
-- Function permissions: browsers may call only these
-- ---------------------------------------------------------------------------------------------
revoke all on function public.login_email(text, text) from public;
grant execute on function public.login_email(text, text) to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
revoke all on function public.trade(text, text, integer) from public, anon;
grant execute on function public.trade(text, text, integer) to authenticated;
grant execute on function public.market_closed(text) to anon, authenticated;
revoke all on function public.sync_discord() from public, anon;
grant execute on function public.sync_discord() to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.apply_shock() from public, anon, authenticated;
revoke all on function public.admin_set_meta(text, jsonb) from public, anon;
revoke all on function public.admin_set_season_end(timestamptz) from public, anon;
revoke all on function public.admin_add_player(text, text, text, integer) from public, anon;
grant execute on function public.admin_set_meta(text, jsonb) to authenticated;
grant execute on function public.admin_set_season_end(timestamptz) to authenticated;
grant execute on function public.admin_add_player(text, text, text, integer) to authenticated;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;
revoke all on function public.accept_terms() from public, anon;
revoke all on function public.confirm_prize_eligibility() from public, anon;
revoke all on function public.admin_set_epic(text, text) from public, anon;
grant execute on function public.accept_terms() to authenticated;
grant execute on function public.confirm_prize_eligibility() to authenticated;
grant execute on function public.admin_set_epic(text, text) to authenticated;
grant select on public.leaderboard to anon, authenticated;

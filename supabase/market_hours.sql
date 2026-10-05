-- Storm Exchange: market hours (run once in Supabase SQL Editor). Safe to re-run.

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

grant execute on function public.market_closed(text) to anon, authenticated;

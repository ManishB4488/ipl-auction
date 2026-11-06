-- Run ONCE in Supabase SQL Editor (after update_process.sql). Adds: watchlist (private), auto-bid up to a maximum.
-- Auto-bid runs inside the database: after every bid (and when a lot opens) the highest-limit auto-bidder responds one step at a time.
create table if not exists watchlist(room_id uuid references rooms on delete cascade, franchise_id uuid references franchises on delete cascade,
  player_id int references players, primary key(franchise_id, player_id));
create table if not exists auto_bids(room_id uuid references rooms on delete cascade, franchise_id uuid references franchises on delete cascade,
  rp_id bigint references room_players on delete cascade, max_lakh int not null, created_at timestamptz default now(), primary key(franchise_id, rp_id));
alter table watchlist enable row level security; alter table auto_bids enable row level security;
drop policy if exists p_watch on watchlist; drop policy if exists p_auto on auto_bids;
create policy p_watch on watchlist for select using (exists(select 1 from franchises f where f.id=franchise_id and f.user_id=auth.uid()));
create policy p_auto on auto_bids for select using (exists(select 1 from franchises f where f.id=franchise_id and f.user_id=auth.uid()));   -- only you see your limits

create or replace function toggle_watch(p_room uuid, p_player int) returns text language plpgsql security definer set search_path=public as $$
declare f franchises;
begin
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if exists(select 1 from watchlist where franchise_id=f.id and player_id=p_player) then
    delete from watchlist where franchise_id=f.id and player_id=p_player;
  else insert into watchlist(room_id,franchise_id,player_id) values(p_room,f.id,p_player); end if;
  return 'ok';
end $$;

create or replace function _run_auto(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms; rp room_players; need int; fr franchises; i int := 0; res text;
begin
  loop
    i := i+1; exit when i>400;
    select * into rm from rooms where id=p_room;
    exit when rm.status<>'live' or rm.cur_rp is null or rm.ends_at<=now();
    select * into rp from room_players where id=rm.cur_rp;
    need := case when rm.cur_bidder is null then rp.base_lakh else rm.cur_bid+inc_for(rm.cur_bid) end;
    select f.* into fr from auto_bids ab join franchises f on f.id=ab.franchise_id
      where ab.rp_id=rp.id and ab.max_lakh>=need and f.id is distinct from rm.cur_bidder
        and not exists(select 1 from passes ps where ps.rp_id=rp.id and ps.franchise_id=f.id)
      order by ab.max_lakh desc, ab.created_at limit 1;
    exit when fr.id is null;
    res := _try_bid(rm, fr, need);
    if res<>'ok' then delete from auto_bids where rp_id=rp.id and franchise_id=fr.id; end if;   -- cannot bid (purse/squad/overseas): drop it
  end loop;
end $$;

create or replace function set_auto_bid(p_room uuid, p_rp bigint, p_max int) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; rp room_players; lim int;
begin
  select * into rm from rooms where id=p_room for update;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  select * into rp from room_players where id=p_rp and room_id=p_room;
  if rp.id is null or rp.status not in ('pending','live') then return 'That player is not available for bidding'; end if;
  if coalesce(p_max,0)<=0 then delete from auto_bids where franchise_id=f.id and rp_id=p_rp; return 'ok'; end if;
  if p_max<rp.base_lakh then return 'Your limit is below the base price ('||rp.base_lakh||' L)'; end if;
  lim := rm.purse_lakh-f.spent_lakh;
  insert into auto_bids(room_id,franchise_id,rp_id,max_lakh) values(p_room,f.id,p_rp,least(p_max,lim))
    on conflict (franchise_id,rp_id) do update set max_lakh=least(p_max,lim);
  if rm.status='live' and rm.cur_rp=p_rp then perform _run_auto(p_room); end if;
  return 'ok';
end $$;

create or replace function bid(p_room uuid, p_amount int) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; res text;
begin
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'live' then return 'Auction is not live'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if rm.ends_at<=now() then perform _settle(p_room); return 'Bidding closed'; end if;
  res := _try_bid(rm,f,p_amount);
  if res='ok' then perform _run_auto(p_room); end if;
  return res;
end $$;

create or replace function _advance(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare nxt room_players; rm rooms;
begin
  select * into nxt from room_players where room_id=p_room and status='pending' order by seq limit 1;
  if nxt.id is null then
    select * into rm from rooms where id=p_room;
    if not rm.accel_done and exists(select 1 from room_players where room_id=p_room and status='unsold') then
      update rooms set status='accel_pick', cur_rp=null, cur_bid=null, cur_bidder=null, ends_at=null, bot_next_at=null where id=p_room;
      update franchises set accel_ready=false where room_id=p_room;
      delete from accel_picks where room_id=p_room;
      perform _bot_picks(p_room);
    else
      update rooms set status='review', cur_rp=null, cur_bid=null, cur_bidder=null, ends_at=null, bot_next_at=null where id=p_room;
    end if;
    return;
  end if;
  update room_players set status='live' where id=nxt.id;
  update rooms set status='live', cur_rp=nxt.id, cur_bid=null, cur_bidder=null,
    ends_at=now()+make_interval(secs=>timer_secs+case when accel_done then 3 else 5 end),
    bot_next_at=now()+make_interval(secs=>3+random()*3) where id=p_room;
  perform _run_auto(p_room);   -- auto-bids can open the lot at the base price
end $$;


create or replace function bot_step(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms; rp room_players; pl players; need int; b record; cnt record; bf franchises;
        fair numeric; fac numeric; mult numeric; mx numeric; v numeric; bestv numeric := -1; best uuid; left_l int; elig boolean; want boolean; tier_p numeric; need_f numeric;
begin
  if auth.uid() is null or not exists(select 1 from franchises where room_id=p_room and user_id=auth.uid()) then return; end if;
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'live' or not rm.fill_bots or rm.bot_next_at is null or rm.bot_next_at>now() or rm.ends_at<=now() then return; end if;
  select * into rp from room_players where id=rm.cur_rp;
  select * into pl from players where id=rp.player_id;
  need := case when rm.cur_bidder is null then rp.base_lakh else rm.cur_bid+inc_for(rm.cur_bid) end;
  if coalesce(rp.bots_skip,false) then   -- host chose: bots sit out this player
    insert into passes(room_id,rp_id,franchise_id) select p_room,rp.id,id from franchises where room_id=p_room and is_bot on conflict do nothing;
    update rooms set bot_next_at=null where id=p_room;
    if (select count(*) from franchises fr where fr.room_id=p_room
          and fr.id<>coalesce((select cur_bidder from rooms where id=p_room),'00000000-0000-0000-0000-000000000000'::uuid)
          and not exists(select 1 from passes ps where ps.rp_id=rp.id and ps.franchise_id=fr.id))=0
    then perform _settle(p_room); end if;
    return;
  end if;
  for b in select * from franchises where room_id=p_room and is_bot and id is distinct from rm.cur_bidder
             and not exists(select 1 from passes where rp_id=rp.id and franchise_id=franchises.id) loop
    left_l := rm.purse_lakh-b.spent_lakh;
    select count(*) filter (where p.role='Wicketkeeper') as wk, count(*) filter (where p.role='Batter') as bat,
           count(*) filter (where p.role='Bowler') as bowl, count(*) filter (where p.role='All-rounder') as ar into cnt
      from room_players r join players p on p.id=r.player_id where r.sold_to=b.id;
    fair := left_l / greatest(22-b.squad_count,1)::numeric;
    fac := case when rp.base_lakh>=200 then 1.85 when rp.base_lakh>=150 then 1.2 when rp.base_lakh>=125 then 1.1
                when rp.base_lakh>=100 then 1.0 when rp.base_lakh>=75 then 0.65 when rp.base_lakh>=50 then 0.38
                when rp.base_lakh>=40 then 0.25 else 0.15 end;
    mult := case pl.role
      when 'Wicketkeeper' then case when cnt.wk=0 then 1.6 when cnt.wk=1 then 1.2 when cnt.wk=2 then 0.7 else 0.3 end
      when 'Batter' then case when cnt.bat<3 then 1.4 when cnt.bat<6 then 1.0 when cnt.bat<8 then 0.6 else 0.3 end
      when 'Bowler' then case when cnt.bowl<4 then 1.4 when cnt.bowl<7 then 1.0 when cnt.bowl<9 then 0.6 else 0.3 end
      else case when cnt.ar<3 then 1.3 when cnt.ar<6 then 1.0 when cnt.ar<8 then 0.6 else 0.3 end end;
    if pl.overseas and b.os_count>=6 then mult := mult*0.7; end if;
    mx := fair*fac*mult*(0.85+(abs(hashtext(b.id::text))%30)/100.0)*(0.9+(abs(hashtext(b.id::text||rp.id::text))%20)/100.0);
    mx := least(mx, 1800, left_l*0.25);   -- hard cap: 18 Cr (1800 lakh) and at most 25% of the bot's remaining purse
    -- bots only bid on players they WANT (not every player): accelerated round = their own picks; main round = need/tier based, varies per bot and player
    if rm.accel_done then
      want := exists(select 1 from accel_picks a where a.franchise_id=b.id and a.rp_id=rp.id);
    else
      tier_p := case when rp.base_lakh>=150 then 0.9 when rp.base_lakh>=100 then 0.7 when rp.base_lakh>=75 then 0.5 when rp.base_lakh>=50 then 0.4 else 0.3 end;
      need_f := case when mult>=1.3 then 1.0 when mult>=1.0 then 0.8 when mult>=0.6 then 0.45 else 0.1 end;
      want := (abs(hashtext('w'||b.id::text||rp.id::text))%100) < tier_p*need_f*100;
    end if;
    elig := b.squad_count<rm.max_squad and not (pl.overseas and b.os_count>=rm.max_overseas)
            and left_l-need >= greatest(rm.min_squad-b.squad_count-1,0)*30;
    if elig and want and need<=mx then
      v := mx*(0.9+random()*0.2);
      if v>bestv then best:=b.id; bestv:=v; end if;
    else
      insert into passes(room_id,rp_id,franchise_id) values(p_room,rp.id,b.id) on conflict do nothing;  -- out for this player
    end if;
  end loop;
  if best is not null then
    select * into bf from franchises where id=best;
    perform _try_bid(rm,bf,need);
    perform _run_auto(p_room);   -- let human auto-bids respond immediately
  else
    update rooms set bot_next_at=null where id=p_room;
  end if;
  if (select count(*) from franchises fr where fr.room_id=p_room
        and fr.id<>coalesce((select cur_bidder from rooms where id=p_room),'00000000-0000-0000-0000-000000000000'::uuid)
        and not exists(select 1 from passes ps where ps.rp_id=rp.id and ps.franchise_id=fr.id))=0
  then perform _settle(p_room); end if;
end $$;

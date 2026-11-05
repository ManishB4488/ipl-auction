-- Run ONCE in Supabase SQL Editor (after schema.sql). Adds AI bot teams + IPL team list.
alter table franchises alter column user_id drop not null;
alter table franchises add column if not exists is_bot boolean default false;
alter table rooms add column if not exists fill_bots boolean default true;
alter table rooms add column if not exists bot_next_at timestamptz;

create or replace function ipl_teams() returns table(name text, color text) language sql immutable as $$
  select * from (values ('Chennai Super Kings','#FDB913'),('Mumbai Indians','#004BA0'),('Royal Challengers Bengaluru','#D1171B'),
    ('Kolkata Knight Riders','#3A225D'),('Delhi Capitals','#17479E'),('Sunrisers Hyderabad','#F26522'),('Rajasthan Royals','#EA1A85'),
    ('Punjab Kings','#D71920'),('Lucknow Super Giants','#00A8E0'),('Gujarat Titans','#1C2C5B')) t(name,color) $$;

create or replace function room_by_code(p_code text) returns json language sql security definer set search_path=public as $$
  select json_build_object('id',id,'name',name,'status',status,
    'teams',(select coalesce(json_agg(team),'[]'::json) from franchises where room_id=rooms.id)) from rooms where code=upper(p_code) $$;

drop function if exists set_rules(uuid,int,int,int,int,int,boolean);
create function set_rules(p_room uuid,p_purse int,p_min int,p_max int,p_os int,p_timer int,p_spec boolean,p_bots boolean) returns void
language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set purse_lakh=p_purse,min_squad=p_min,max_squad=p_max,max_overseas=p_os,timer_secs=p_timer,spectators=p_spec,fill_bots=p_bots
   where id=p_room and status in('lobby','paused'); end $$;

-- start: fill empty seats up to 10 franchises with bots using the remaining IPL teams
create or replace function start_room(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; n int; t record;
begin perform _host(p_room);
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'lobby' then return 'Already started'; end if;
  select count(*) into n from franchises where room_id=p_room;
  if n<3 then return 'Need at least 3 franchises'; end if;
  if rm.fill_bots then
    for t in select x.name, x.color from ipl_teams() x
             where not exists(select 1 from franchises f where f.room_id=p_room and lower(f.team)=lower(x.name))
             order by random() limit greatest(10-n,0) loop
      insert into franchises(room_id,user_id,owner,team,color,is_bot) values(p_room,null,'AI Bot',t.name,t.color,true);
    end loop;
  end if;
  perform _advance(p_room); return 'ok';
end $$;

create or replace function _advance(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare nxt room_players;
begin
  select * into nxt from room_players where room_id=p_room and status='pending' order by seq limit 1;
  if nxt.id is null then
    update rooms set status='review', cur_rp=null, cur_bid=null, cur_bidder=null, ends_at=null, bot_next_at=null where id=p_room; return;
  end if;
  update room_players set status='live' where id=nxt.id;
  update rooms set status='live', cur_rp=nxt.id, cur_bid=null, cur_bidder=null, ends_at=now()+make_interval(secs=>timer_secs+5),
    bot_next_at=now()+make_interval(secs=>3+random()*3) where id=p_room;
end $$;

-- shared bid validation (used by humans and bots)
create or replace function _try_bid(rm rooms, f franchises, p_amount int) returns text language plpgsql security definer set search_path=public as $$
declare rp room_players; pl players; need int;
begin
  select * into rp from room_players where id=rm.cur_rp;
  select * into pl from players where id=rp.player_id;
  if exists(select 1 from passes where rp_id=rp.id and franchise_id=f.id) then return 'You passed on this player'; end if;
  if rm.cur_bidder=f.id then return 'You already hold the highest bid'; end if;
  need := case when rm.cur_bidder is null then rp.base_lakh else rm.cur_bid+inc_for(rm.cur_bid) end;
  if p_amount<>need then return 'Bid moved on - next bid is '||need||' L'; end if;
  if f.squad_count>=rm.max_squad then return 'Squad is full'; end if;
  if pl.overseas and f.os_count>=rm.max_overseas then return 'Overseas limit reached'; end if;
  if rm.purse_lakh-f.spent_lakh-need < greatest(rm.min_squad-f.squad_count-1,0)*30
    then return 'Not enough purse (must keep 30 L per slot to reach minimum squad)'; end if;
  insert into bids(room_id,rp_id,franchise_id,amount) values(rm.id,rp.id,f.id,need);
  update rooms set cur_bid=need, cur_bidder=f.id, ends_at=now()+make_interval(secs=>rm.timer_secs),
    bot_next_at=now()+make_interval(secs=>1.5+random()*2.5) where id=rm.id;
  return 'ok';
end $$;

create or replace function bid(p_room uuid, p_amount int) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises;
begin
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'live' then return 'Auction is not live'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if rm.ends_at<=now() then perform _settle(p_room); return 'Bidding closed'; end if;
  return _try_bid(rm,f,p_amount);
end $$;

-- Bot brain. Any participant's browser calls this every few seconds; the server decides if a bot acts.
-- Value = fair share of remaining purse x player tier x team need (WK/bat/bowl/all-rounder balance, overseas) x bot personality.
create or replace function bot_step(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms; rp room_players; pl players; need int; b record; cnt record; bf franchises;
        fair numeric; fac numeric; mult numeric; mx numeric; v numeric; bestv numeric := -1; best uuid; left_l int; elig boolean;
begin
  if auth.uid() is null or not exists(select 1 from franchises where room_id=p_room and user_id=auth.uid()) then return; end if;
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'live' or not rm.fill_bots or rm.bot_next_at is null or rm.bot_next_at>now() or rm.ends_at<=now() then return; end if;
  select * into rp from room_players where id=rm.cur_rp;
  select * into pl from players where id=rp.player_id;
  need := case when rm.cur_bidder is null then rp.base_lakh else rm.cur_bid+inc_for(rm.cur_bid) end;
  for b in select * from franchises where room_id=p_room and is_bot and id is distinct from rm.cur_bidder
             and not exists(select 1 from passes where rp_id=rp.id and franchise_id=franchises.id) loop
    left_l := rm.purse_lakh-b.spent_lakh;
    select count(*) filter (where p.role='Wicketkeeper') as wk, count(*) filter (where p.role='Batter') as bat,
           count(*) filter (where p.role='Bowler') as bowl, count(*) filter (where p.role='All-rounder') as ar into cnt
      from room_players r join players p on p.id=r.player_id where r.sold_to=b.id;
    fair := left_l / greatest(22-b.squad_count,1)::numeric;
    fac := case when rp.base_lakh>=200 then 2.8 when rp.base_lakh>=150 then 2.0 when rp.base_lakh>=125 then 1.7
                when rp.base_lakh>=100 then 1.4 when rp.base_lakh>=75 then 0.9 when rp.base_lakh>=50 then 0.6
                when rp.base_lakh>=40 then 0.5 else 0.35 end;
    mult := case pl.role
      when 'Wicketkeeper' then case when cnt.wk=0 then 1.6 when cnt.wk=1 then 1.2 when cnt.wk=2 then 0.7 else 0.3 end
      when 'Batter' then case when cnt.bat<3 then 1.4 when cnt.bat<6 then 1.0 when cnt.bat<8 then 0.6 else 0.3 end
      when 'Bowler' then case when cnt.bowl<4 then 1.4 when cnt.bowl<7 then 1.0 when cnt.bowl<9 then 0.6 else 0.3 end
      else case when cnt.ar<3 then 1.3 when cnt.ar<6 then 1.0 when cnt.ar<8 then 0.6 else 0.3 end end;
    if pl.overseas and b.os_count>=6 then mult := mult*0.7; end if;
    mx := fair*fac*mult*(0.85+(abs(hashtext(b.id::text))%30)/100.0)*(0.9+(abs(hashtext(b.id::text||rp.id::text))%20)/100.0);
    elig := b.squad_count<rm.max_squad and not (pl.overseas and b.os_count>=rm.max_overseas)
            and left_l-need >= greatest(rm.min_squad-b.squad_count-1,0)*30;
    if elig and need<=mx then
      v := mx*(0.9+random()*0.2);
      if v>bestv then best:=b.id; bestv:=v; end if;
    else
      insert into passes(room_id,rp_id,franchise_id) values(p_room,rp.id,b.id) on conflict do nothing;  -- out for this player
    end if;
  end loop;
  if best is not null then
    select * into bf from franchises where id=best;
    perform _try_bid(rm,bf,need);
  else
    update rooms set bot_next_at=null where id=p_room;
  end if;
  if (select count(*) from franchises fr where fr.room_id=p_room
        and fr.id<>coalesce((select cur_bidder from rooms where id=p_room),'00000000-0000-0000-0000-000000000000'::uuid)
        and not exists(select 1 from passes ps where ps.rp_id=rp.id and ps.franchise_id=fr.id))=0
  then perform _settle(p_room); end if;
end $$;
revoke all on function _try_bid(rooms,franchises,int) from public, anon, authenticated;

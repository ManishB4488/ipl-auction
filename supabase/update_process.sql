-- Run ONCE in Supabase SQL Editor (after update_bot_controls.sql). New auction process:
--  * Capped players first, in blocks that REPEAT until the capped pool is used up:
--      15 Indian batters, 10 overseas batters, 15 all-rounders, 10 wicketkeepers, 10 Indian bowlers, 10 overseas bowlers
--  * Uncapped only after ALL capped players: 15 batters, 15 all-rounders, 10 wicketkeepers, 20 bowlers (repeating)
--  * At the end: every franchise picks 5-10 unsold players; those are auctioned in an accelerated round with a 7-second timer
--  * Bots only bid on players they want (not on everyone)
alter table room_players add column if not exists blk_label text;
alter table rooms add column if not exists accel_done boolean default false;
alter table rooms add column if not exists accel_secs int default 7;
alter table franchises add column if not exists accel_ready boolean default false;
create table if not exists accel_picks(room_id uuid references rooms on delete cascade, franchise_id uuid references franchises on delete cascade,
  rp_id bigint references room_players on delete cascade, primary key(franchise_id, rp_id));
alter table accel_picks enable row level security;
drop policy if exists p_picks on accel_picks;
create policy p_picks on accel_picks for select using (exists(select 1 from franchises f where f.id=franchise_id and f.user_id=auth.uid()));  -- you only see your own picks

drop function if exists create_room(text,text,text,text,int,boolean,text);
create function create_room(p_name text,p_owner text,p_team text,p_color text,p_max_set int default 99,p_retained boolean default true,p_order text default 'pattern') returns text
language plpgsql security definer set search_path=public as $$
declare rid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
  insert into rooms(code,name,host_id) values(c,p_name,auth.uid()) returning id into rid;
  insert into franchises(room_id,user_id,owner,team,color) values(rid,auth.uid(),p_owner,p_team,p_color);
  with b as (
    select id, base_lakh, set_no, list_no, coalesce(retained,false) as retained, (capped='Capped') as cap,
      case when capped='Capped' then
        case role when 'Batter' then case when overseas then 2 else 1 end when 'All-rounder' then 3 when 'Wicketkeeper' then 4 else case when overseas then 6 else 5 end end
      else case role when 'Batter' then 1 when 'All-rounder' then 2 when 'Wicketkeeper' then 3 else 4 end end as blk,
      case when capped='Capped' then
        case role when 'Batter' then case when overseas then 10 else 15 end when 'All-rounder' then 15 else 10 end
      else case role when 'Batter' then 15 when 'All-rounder' then 15 when 'Wicketkeeper' then 10 else 20 end end as quota,
      case when capped='Capped' then 'Capped - '||case role when 'Batter' then case when overseas then 'Overseas Batters' else 'Indian Batters' end
           when 'All-rounder' then 'All-rounders' when 'Wicketkeeper' then 'Wicketkeepers' else case when overseas then 'Overseas Bowlers' else 'Indian Bowlers' end end
      else 'Uncapped - '||case role when 'Batter' then 'Batters' when 'All-rounder' then 'All-rounders' when 'Wicketkeeper' then 'Wicketkeepers' else 'Bowlers' end end as lbl
    from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false))
  ), c2 as (
    select b.*, (row_number() over (partition by cap, blk order by retained desc, base_lakh desc, list_no)) - 1 as r from b
  )
  insert into room_players(room_id,player_id,seq,base_lakh,blk_label)
  select rid, id, row_number() over (order by
      (case when p_order='sets' then 0 else (not cap)::int end),
      (case when p_order='sets' then set_no else r/quota end),
      (case when p_order='sets' then 0 else blk end),
      (case when p_order='sets' then list_no else r end)), base_lakh, lbl from c2;
  return c;
end $$;

create or replace function _bot_picks(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare b record; n int; mo int;
begin
  select max_overseas into mo from rooms where id=p_room;
  for b in select * from franchises where room_id=p_room and is_bot loop
    n := 5 + floor(random()*4)::int;
    insert into accel_picks(room_id,franchise_id,rp_id)
      select p_room, b.id, r.id from room_players r join players p on p.id=r.player_id
       where r.room_id=p_room and r.status='unsold' and not (p.overseas and b.os_count>=mo)
       order by r.base_lakh * (case when (select count(*) from room_players rr join players pp on pp.id=rr.player_id where rr.sold_to=b.id and pp.role=p.role)<4 then 1.4 else 0.6 end) * (0.5+random()) desc
       limit n;
    update franchises set accel_ready=true where id=b.id;
  end loop;
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
end $$;

create or replace function submit_picks(p_room uuid, p_rps bigint[]) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; n int; avail int;
begin
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'accel_pick' then return 'Not in the picking stage'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  select count(*) into avail from room_players where room_id=p_room and status='unsold';
  n := coalesce(array_length(p_rps,1),0);
  if f.squad_count<rm.max_squad and n<least(5,avail) then return 'Pick at least '||least(5,avail)||' players'; end if;
  if n>10 then return 'Pick at most 10 players'; end if;
  if exists(select 1 from unnest(p_rps) x where not exists(select 1 from room_players where id=x and room_id=p_room and status='unsold')) then
    return 'Some picked players are not available'; end if;
  delete from accel_picks where franchise_id=f.id;
  insert into accel_picks(room_id,franchise_id,rp_id) select p_room,f.id,q.x from (select distinct unnest(p_rps) as x) q;
  update franchises set accel_ready=true where id=f.id;
  return 'ok';
end $$;

create or replace function host_start_accel(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms;
begin
  perform _host(p_room);
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'accel_pick' then return 'Not in the picking stage'; end if;
  update room_players r set status='pending', sold_at=null,
      seq = 1000000 - (select count(*) from accel_picks a where a.rp_id=r.id)*10000 - r.base_lakh
    where r.room_id=p_room and r.status='unsold' and exists(select 1 from accel_picks a where a.rp_id=r.id);
  delete from passes where room_id=p_room;
  update rooms set accel_done=true, timer_secs=accel_secs where id=p_room;
  perform _advance(p_room);
  return 'ok';
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
  else
    update rooms set bot_next_at=null where id=p_room;
  end if;
  if (select count(*) from franchises fr where fr.room_id=p_room
        and fr.id<>coalesce((select cur_bidder from rooms where id=p_room),'00000000-0000-0000-0000-000000000000'::uuid)
        and not exists(select 1 from passes ps where ps.rp_id=rp.id and ps.franchise_id=fr.id))=0
  then perform _settle(p_room); end if;
end $$;

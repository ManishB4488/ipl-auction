-- IPL 2026 Auction: run ONCE in Supabase SQL Editor (then run seed_players.sql).
-- All money is stored in LAKH (120 crore = 12000). Every state change goes through SECURITY DEFINER functions;
-- clients have SELECT-only access via RLS, so purses/bids/ownership cannot be tampered with from the browser.
create extension if not exists pgcrypto;

create table players(
  id serial primary key, list_no int unique, set_no int, set_code text, name text, country text, overseas boolean,
  capped text, role text, bat text, bowl text, base_lakh int, ipl_team_2025 text, ipl_matches int, dob text, caps_raw text);

create table rooms(
  id uuid primary key default gen_random_uuid(), code text unique not null, name text, host_id uuid not null,
  status text not null default 'lobby',            -- lobby | live | paused | review | done
  purse_lakh int default 12000, min_squad int default 18, max_squad int default 25, max_overseas int default 8,
  timer_secs int default 20, spectators boolean default true,
  cur_rp bigint, cur_bid int, cur_bidder uuid, ends_at timestamptz, paused_ms int, created_at timestamptz default now());

create table franchises(
  id uuid primary key default gen_random_uuid(), room_id uuid references rooms on delete cascade, user_id uuid not null,
  owner text, team text, color text, spent_lakh int default 0, squad_count int default 0, os_count int default 0,
  created_at timestamptz default now(), unique(room_id,user_id));
create unique index on franchises(room_id, lower(team));

create table room_players(
  id bigserial primary key, room_id uuid references rooms on delete cascade, player_id int references players,
  seq int, base_lakh int, status text default 'pending',   -- pending | live | sold | unsold
  sold_to uuid references franchises, sold_lakh int, sold_at timestamptz, unique(room_id,player_id));
create table bids(id bigserial primary key, room_id uuid references rooms on delete cascade, rp_id bigint, franchise_id uuid, amount int, created_at timestamptz default now());
create table passes(room_id uuid, rp_id bigint, franchise_id uuid, primary key(rp_id,franchise_id));
create table audit(id bigserial primary key, room_id uuid, actor uuid, action text, detail jsonb, at timestamptz default now());

-- ---------- Row level security: read-only ----------
alter table players enable row level security; alter table rooms enable row level security; alter table franchises enable row level security;
alter table room_players enable row level security; alter table bids enable row level security; alter table passes enable row level security; alter table audit enable row level security;
create function can_view(r uuid) returns boolean language sql security definer stable set search_path=public as $$
  select exists(select 1 from rooms where id=r and (spectators or host_id=auth.uid()))
      or exists(select 1 from franchises where room_id=r and user_id=auth.uid()) $$;
create policy p_players on players for select using (true);
create policy p_rooms on rooms for select using (can_view(id));
create policy p_fr on franchises for select using (can_view(room_id));
create policy p_rp on room_players for select using (can_view(room_id));
create policy p_bids on bids for select using (can_view(room_id));
create policy p_passes on passes for select using (can_view(room_id));
create policy p_audit on audit for select using (exists(select 1 from rooms where id=room_id and host_id=auth.uid()));

-- ---------- helpers ----------
create function inc_for(c int) returns int language sql immutable as $$ select case when c<100 then 5 when c<200 then 10 when c<500 then 20 else 25 end $$;
create function _host(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin if not exists(select 1 from rooms where id=p_room and host_id=auth.uid()) then raise exception 'Host only'; end if; end $$;

create function _advance(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare nxt room_players;
begin
  select * into nxt from room_players where room_id=p_room and status='pending' order by seq limit 1;
  if nxt.id is null then
    update rooms set status='review', cur_rp=null, cur_bid=null, cur_bidder=null, ends_at=null where id=p_room; return;
  end if;
  update room_players set status='live' where id=nxt.id;
  update rooms set status='live', cur_rp=nxt.id, cur_bid=null, cur_bidder=null, ends_at=now()+make_interval(secs=>timer_secs+5) where id=p_room;
end $$;

create function _settle(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms; rp room_players; os int;
begin
  select * into rm from rooms where id=p_room;
  if rm.cur_rp is null then return; end if;
  select * into rp from room_players where id=rm.cur_rp;
  if rp.status<>'live' then return; end if;
  if rm.cur_bidder is null then
    update room_players set status='unsold', sold_at=now() where id=rp.id;
  else
    select case when overseas then 1 else 0 end into os from players where id=rp.player_id;
    update room_players set status='sold', sold_to=rm.cur_bidder, sold_lakh=rm.cur_bid, sold_at=now() where id=rp.id;
    update franchises set spent_lakh=spent_lakh+rm.cur_bid, squad_count=squad_count+1, os_count=os_count+os where id=rm.cur_bidder;
  end if;
  perform _advance(p_room);
end $$;
revoke all on function _advance(uuid), _settle(uuid), _host(uuid) from public, anon, authenticated;

-- ---------- room lifecycle ----------
create function room_by_code(p_code text) returns json language sql security definer set search_path=public as $$
  select json_build_object('id',id,'name',name,'status',status) from rooms where code=upper(p_code) $$;

create function create_room(p_name text,p_owner text,p_team text,p_color text,p_max_set int default 99) returns text
language plpgsql security definer set search_path=public as $$
declare rid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
  insert into rooms(code,name,host_id) values(c,p_name,auth.uid()) returning id into rid;
  insert into franchises(room_id,user_id,owner,team,color) values(rid,auth.uid(),p_owner,p_team,p_color);
  insert into room_players(room_id,player_id,seq,base_lakh)
    select rid,id,row_number() over(order by set_no,list_no),base_lakh from players where set_no<=p_max_set;
  return c;
end $$;

create function join_room(p_code text,p_owner text,p_team text,p_color text) returns uuid
language plpgsql security definer set search_path=public as $$
declare rm rooms; n int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into rm from rooms where code=upper(p_code) for update;
  if rm.id is null then raise exception 'Room not found'; end if;
  if exists(select 1 from franchises where room_id=rm.id and user_id=auth.uid()) then return rm.id; end if;  -- reconnect
  if rm.status<>'lobby' then raise exception 'Auction already started'; end if;
  select count(*) into n from franchises where room_id=rm.id;
  if n>=10 then raise exception 'Room is full (max 10)'; end if;
  insert into franchises(room_id,user_id,owner,team,color) values(rm.id,auth.uid(),p_owner,p_team,p_color);
  return rm.id;
end $$;

create function set_rules(p_room uuid,p_purse int,p_min int,p_max int,p_os int,p_timer int,p_spec boolean) returns void
language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set purse_lakh=p_purse,min_squad=p_min,max_squad=p_max,max_overseas=p_os,timer_secs=p_timer,spectators=p_spec
   where id=p_room and status in('lobby','paused'); end $$;

create function start_room(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  if (select count(*) from franchises where room_id=p_room)<3 then return 'Need at least 3 franchises'; end if;
  if (select status from rooms where id=p_room)<>'lobby' then return 'Already started'; end if;
  perform _advance(p_room); return 'ok'; end $$;

-- ---------- bidding ----------
create function bid(p_room uuid, p_amount int) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; rp room_players; pl players; need int;
begin
  select * into rm from rooms where id=p_room for update;                       -- serialises concurrent bids
  if rm.status<>'live' then return 'Auction is not live'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if rm.ends_at<=now() then perform _settle(p_room); return 'Bidding closed'; end if;
  select * into rp from room_players where id=rm.cur_rp;
  select * into pl from players where id=rp.player_id;
  if exists(select 1 from passes where rp_id=rp.id and franchise_id=f.id) then return 'You passed on this player'; end if;
  if rm.cur_bidder=f.id then return 'You already hold the highest bid'; end if;
  need := case when rm.cur_bidder is null then rp.base_lakh else rm.cur_bid+inc_for(rm.cur_bid) end;
  if p_amount<>need then return 'Bid moved on - next bid is '||need||' L'; end if;  -- stale/duplicate click
  if f.squad_count>=rm.max_squad then return 'Squad is full'; end if;
  if pl.overseas and f.os_count>=rm.max_overseas then return 'Overseas limit reached'; end if;
  if rm.purse_lakh-f.spent_lakh-need < greatest(rm.min_squad-f.squad_count-1,0)*30
    then return 'Not enough purse (must keep 30 L per slot to reach minimum squad)'; end if;
  insert into bids(room_id,rp_id,franchise_id,amount) values(p_room,rp.id,f.id,need);
  update rooms set cur_bid=need, cur_bidder=f.id, ends_at=now()+make_interval(secs=>rm.timer_secs) where id=p_room;
  return 'ok';
end $$;

create function pass(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises;
begin
  select * into rm from rooms where id=p_room for update;
  if rm.status<>'live' then return 'Auction is not live'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if rm.cur_bidder=f.id then return 'You hold the highest bid'; end if;
  insert into passes(room_id,rp_id,franchise_id) values(p_room,rm.cur_rp,f.id) on conflict do nothing;
  if (select count(*) from franchises fr where fr.room_id=p_room
        and fr.id<>coalesce(rm.cur_bidder,'00000000-0000-0000-0000-000000000000'::uuid)
        and not exists(select 1 from passes ps where ps.rp_id=rm.cur_rp and ps.franchise_id=fr.id))=0
  then perform _settle(p_room); end if;                                          -- everyone else passed
  return 'ok';
end $$;

create function tick(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms;
begin
  select * into rm from rooms where id=p_room for update;
  if rm.status='live' and rm.ends_at<=now() then perform _settle(p_room); end if;
end $$;

-- ---------- host controls ----------
create function host_pause(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set status='paused', paused_ms=greatest(0,(extract(epoch from ends_at-now())*1000)::int) where id=p_room and status='live'; end $$;
create function host_resume(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set status='live', ends_at=now()+make_interval(secs=>coalesce(paused_ms,0)/1000.0) where id=p_room and status='paused'; end $$;
create function host_unsold(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set cur_bidder=null,cur_bid=null where id=p_room and status in('live','paused');
  update rooms set status='live' where id=p_room and status='paused';
  perform _settle(p_room); end $$;
create function host_skip(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare rm rooms;
begin perform _host(p_room);
  select * into rm from rooms where id=p_room for update;
  if rm.cur_rp is null then return; end if;
  update room_players set status='pending', seq=(select max(seq)+1 from room_players where room_id=p_room) where id=rm.cur_rp;
  delete from passes where rp_id=rm.cur_rp; delete from bids where rp_id=rm.cur_rp;
  perform _advance(p_room); end $$;
create function host_set_base(p_rp bigint,p_lakh int) returns void language plpgsql security definer set search_path=public as $$
declare r uuid;
begin select room_id into r from room_players where id=p_rp; perform _host(r);
  update room_players set base_lakh=p_lakh where id=p_rp and status='pending';
  insert into audit(room_id,actor,action,detail) values(r,auth.uid(),'set_base',jsonb_build_object('rp',p_rp,'lakh',p_lakh)); end $$;
create function host_undo_sale(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare rp room_players; os int; rm rooms;
begin perform _host(p_room);
  select * into rm from rooms where id=p_room for update;
  select * into rp from room_players where room_id=p_room and status='sold' order by sold_at desc limit 1;
  if rp.id is null then return 'Nothing to undo'; end if;
  select case when overseas then 1 else 0 end into os from players where id=rp.player_id;
  update franchises set spent_lakh=spent_lakh-rp.sold_lakh, squad_count=squad_count-1, os_count=os_count-os where id=rp.sold_to;
  insert into audit(room_id,actor,action,detail) values(p_room,auth.uid(),'undo_sale',to_jsonb(rp));
  update room_players set status='pending',sold_to=null,sold_lakh=null,sold_at=null,
    seq=(select coalesce(min(seq),1)-1 from room_players where room_id=p_room) where id=rp.id;
  delete from passes where rp_id=rp.id;
  if rm.status in('review','done') then perform _advance(p_room); end if;
  return 'ok'; end $$;
create function host_reauction(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  if (select status from rooms where id=p_room)<>'review' then return 'Only available after the first round'; end if;
  delete from passes where room_id=p_room;
  update room_players set status='pending', sold_at=null, seq=seq+100000 where room_id=p_room and status='unsold';
  perform _advance(p_room); return 'ok'; end $$;
create function host_end(p_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update room_players set status='unsold' where room_id=p_room and status='live';
  update rooms set status='done',cur_rp=null,cur_bid=null,cur_bidder=null,ends_at=null where id=p_room;
  insert into audit(room_id,actor,action) values(p_room,auth.uid(),'end'); end $$;

alter publication supabase_realtime add table rooms, franchises, room_players, bids;

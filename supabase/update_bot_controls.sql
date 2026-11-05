-- Run ONCE in Supabase SQL Editor (after the pricing v2 update). Host bot controls:
--  1) host_bots: switch ALL bots on/off at any time   2) host_bots_skip: bots sit out a chosen player (current or upcoming)
-- Also re-installs bot_step with the v2 pricing plus the "sit out" check.
alter table room_players add column if not exists bots_skip boolean default false;

create or replace function host_bots(p_room uuid, p_on boolean) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update rooms set fill_bots=p_on,
    bot_next_at=case when p_on and status='live' then now()+interval '2 seconds' else bot_next_at end where id=p_room;
end $$;

create or replace function host_bots_skip(p_room uuid, p_rp bigint, p_skip boolean) returns void language plpgsql security definer set search_path=public as $$
begin perform _host(p_room);
  update room_players set bots_skip=p_skip where id=p_rp and room_id=p_room and status in('pending','live');
  update rooms set bot_next_at=now() where id=p_room and cur_rp=p_rp and status='live';   -- apply immediately to the current player
end $$;

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

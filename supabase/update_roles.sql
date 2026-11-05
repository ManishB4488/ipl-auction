-- Run ONCE in Supabase SQL Editor (after update_retained.sql). Adds "auction order" to Create Room.
-- 'role' = Batters -> Wicketkeepers -> All-rounders -> Bowlers; inside each block: retained stars first, then highest base price first.
-- 'sets' = the official set order.
drop function if exists create_room(text,text,text,text,int,boolean);
create function create_room(p_name text,p_owner text,p_team text,p_color text,p_max_set int default 99,p_retained boolean default true,p_order text default 'role') returns text
language plpgsql security definer set search_path=public as $$
declare rid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
  insert into rooms(code,name,host_id) values(c,p_name,auth.uid()) returning id into rid;
  insert into franchises(room_id,user_id,owner,team,color) values(rid,auth.uid(),p_owner,p_team,p_color);
  insert into room_players(room_id,player_id,seq,base_lakh)
    select rid,id,row_number() over(order by
        case when p_order='role' then case role when 'Batter' then 1 when 'Wicketkeeper' then 2 when 'All-rounder' then 3 else 4 end else 0 end,
        case when p_order='role' and not coalesce(retained,false) then 1 else 0 end,
        case when p_order='role' then -base_lakh else 0 end,
        set_no, list_no), base_lakh
    from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false));
  return c;
end $$;

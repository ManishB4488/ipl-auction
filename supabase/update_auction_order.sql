-- Run ONCE in Supabase SQL Editor (after update_roles.sql). Adds the new "Capped first, then Uncapped" auction order.
--
-- CAPPED phase (runs completely first), in this order and with these block sizes (p_quota):
--    1) 15 Indian capped Batters      2) 10 Overseas capped Batters   3) 15 All-rounders (Indian + overseas)
--    4) 10 Wicketkeepers              5) 10 Indian capped Bowlers     6) 10 Overseas capped Bowlers
-- UNCAPPED phase (starts only after every capped player is done):
--    Batters -> All-rounders -> Wicketkeepers -> Bowlers (Indian first, then overseas inside each role). All uncapped players are included.
-- Inside every block: retained stars first, then highest base price first.
-- Capped players beyond a block's quota are NOT dropped (p_leftover = true): they are auctioned at the END of the capped phase,
-- in the same category order, still before any uncapped player. Pass p_leftover = false to leave them out of the room.
-- The old orders still work: p_order = 'role' or 'sets'.
alter table room_players add column if not exists block_label text;

drop function if exists create_room(text,text,text,text,int,boolean,text);
create function create_room(p_name text,p_owner text,p_team text,p_color text,p_max_set int default 99,p_retained boolean default true,
                            p_order text default 'capped_first',p_quota int[] default '{15,10,15,10,10,10}',p_leftover boolean default true) returns text
language plpgsql security definer set search_path=public as $$
declare rid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
  insert into rooms(code,name,host_id) values(c,p_name,auth.uid()) returning id into rid;
  insert into franchises(room_id,user_id,owner,team,color) values(rid,auth.uid(),p_owner,p_team,p_color);

  if p_order='capped_first' then
    if coalesce(array_length(p_quota,1),0)<>6 then raise exception 'p_quota needs 6 numbers'; end if;
    insert into room_players(room_id,player_id,seq,base_lakh,block_label)
    with src as (
      select id, base_lakh, set_no, list_no, overseas, coalesce(retained,false) as ret, (capped='Capped') as is_capped,
             case when capped='Capped' then
                    case role when 'Batter' then case when overseas then 2 else 1 end
                              when 'All-rounder' then 3
                              when 'Wicketkeeper' then 4
                              else case when overseas then 6 else 5 end end
                  else case role when 'Batter' then 1 when 'All-rounder' then 2 when 'Wicketkeeper' then 3 else 4 end end as cat
        from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false))),
    ranked as (
      select *, row_number() over(partition by is_capped, cat order by case when ret then 0 else 1 end, -base_lakh, set_no, list_no) as rnk from src),
    q as (
      select *, (is_capped and rnk>p_quota[cat]) as extra from ranked)
    select rid, id,
           row_number() over(order by case when is_capped then 0 else 1 end, case when extra then 1 else 0 end, cat,
                                      case when is_capped then 0 when overseas then 1 else 0 end, rnk),
           base_lakh,
           (case when is_capped then 'Capped' else 'Uncapped' end) || ' · ' ||
           (case when is_capped then (array['Indian Batters','Overseas Batters','All-rounders','Wicketkeepers','Indian Bowlers','Overseas Bowlers'])[cat]
                 else (array['Batters','All-rounders','Wicketkeepers','Bowlers'])[cat] end) ||
           (case when extra then ' (remaining)' else '' end)
      from q
     where p_leftover or not extra;
  else
    insert into room_players(room_id,player_id,seq,base_lakh)
      select rid,id,row_number() over(order by
          case when p_order='role' then case role when 'Batter' then 1 when 'Wicketkeeper' then 2 when 'All-rounder' then 3 else 4 end else 0 end,
          case when p_order='role' and not coalesce(retained,false) then 1 else 0 end,
          case when p_order='role' then -base_lakh else 0 end,
          set_no, list_no), base_lakh
      from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false));
  end if;
  return c;
end $$;

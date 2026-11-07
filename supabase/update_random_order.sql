-- Run ONCE in Supabase SQL Editor (after all the other update_*.sql files).
-- Adds RANDOM auction orders (new rooms only; rooms that already exist keep their order):
--   'shuffle'      (new default) capped players first, uncapped after - but inside each phase EVERYONE is shuffled:
--                  an Indian capped batter can be followed by an overseas bowler, an all-rounder, a keeper... in any order.
--   'shuffle_all'  completely random: capped and uncapped mixed together.
-- 'capped_first' keeps its fixed role blocks (15 Ind bat, 10 Os bat, ...) but the players INSIDE every block are now shuffled for each room
--                  (block membership is still decided by retained status / base price, so the stars stay in the main blocks).
-- Older modes 'role' and 'sets' are unchanged.
-- A new shuffle is drawn every time a room is created, so no two auctions run in the same order.
alter table room_players add column if not exists blk_label text;

-- remove every old version of create_room so the new one is the only one (avoids "function is not unique" errors)
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p where p.proname='create_room' and p.pronamespace='public'::regnamespace loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function create_room(p_name text,p_owner text,p_team text,p_color text,p_max_set int default 99,p_retained boolean default true,
                            p_order text default 'shuffle',p_quota int[] default '{15,10,15,10,10,10}',p_leftover boolean default true) returns text
language plpgsql security definer set search_path=public as $$
declare rid uuid; c text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
  insert into rooms(code,name,host_id) values(c,p_name,auth.uid()) returning id into rid;
  insert into franchises(room_id,user_id,owner,team,color) values(rid,auth.uid(),p_owner,p_team,p_color);

  if p_order='capped_first' then
    if coalesce(array_length(p_quota,1),0)<>6 then raise exception 'p_quota needs 6 numbers'; end if;
    insert into room_players(room_id,player_id,seq,base_lakh,blk_label)
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
                                      case when is_capped then 0 when overseas then 1 else 0 end, random()),   -- shuffled inside every block
           base_lakh,
           (case when is_capped then 'Capped' else 'Uncapped' end) || ' · ' ||
           (case when is_capped then (array['Indian Batters','Overseas Batters','All-rounders','Wicketkeepers','Indian Bowlers','Overseas Bowlers'])[cat]
                 else (array['Batters','All-rounders','Wicketkeepers','Bowlers'])[cat] end) ||
           (case when extra then ' (remaining)' else '' end)
      from q
     where p_leftover or not extra;
  elsif p_order in ('role','sets') then
    insert into room_players(room_id,player_id,seq,base_lakh)
      select rid,id,row_number() over(order by
          case when p_order='role' then case role when 'Batter' then 1 when 'Wicketkeeper' then 2 when 'All-rounder' then 3 else 4 end else 0 end,
          case when p_order='role' and not coalesce(retained,false) then 1 else 0 end,
          case when p_order='role' then -base_lakh else 0 end,
          set_no, list_no), base_lakh
      from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false));
  else   -- 'shuffle' (default), 'shuffle_all' and any other value
    insert into room_players(room_id,player_id,seq,base_lakh,blk_label)
      select rid, id,
             row_number() over(order by case when p_order='shuffle_all' then 0 when capped='Capped' then 0 else 1 end, random()),
             base_lakh,
             (case when capped='Capped' then 'Capped' else 'Uncapped' end) || ' · ' || (case when overseas then 'Overseas ' else 'Indian ' end) || role
        from players where set_no<=p_max_set and (p_retained or not coalesce(retained,false));
  end if;
  return c;
end $$;

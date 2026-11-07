-- Run ONCE in Supabase SQL Editor (after the other update_*.sql files).
-- Adds: Playing XI planner (11 slots in batting order, captain, vice-captain, backups per slot).
--  * During the auction the XI is a private plan: slots can hold players you already own or "targets" still to come.
--  * When the auction is over (room status 'done') each franchise can LOCK its final XI.
--  * Other people can only see your XI once it is locked or the room is 'done'.
drop table if exists lineups cascade;   -- safe to re-run; only affects the XI feature
create table lineups(
  franchise_id uuid primary key references franchises on delete cascade,
  room_id uuid not null references rooms on delete cascade,
  slots jsonb not null,                      -- [{want:'Batter', pid:12|null} x 11], index = batting order
  backups jsonb not null default '{}',       -- {"0":[pid,pid], "3":[pid]}  (slot index -> up to 2 backup player ids)
  captain int, vice int,
  locked boolean not null default false,
  updated_at timestamptz default now());
alter table lineups enable row level security;

drop policy if exists p_lineups on lineups;
create policy p_lineups on lineups for select using (
  exists(select 1 from franchises f where f.id=franchise_id and f.user_id=auth.uid())                 -- always your own
  or (can_view(room_id) and (locked or exists(select 1 from rooms r where r.id=room_id and r.status='done'))));

-- autosave from the planner (draft only; ownership is NOT required yet because targets are allowed)
create or replace function save_lineup(p_room uuid, p_slots jsonb, p_backups jsonb, p_captain int, p_vice int) returns text
language plpgsql security definer set search_path=public as $$
declare f franchises; ex lineups; s jsonb; w text; pids int[] := '{}'; pid int;
begin
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  select * into ex from lineups where franchise_id=f.id;
  if ex.franchise_id is not null and ex.locked then return 'Your XI is locked - unlock it to edit'; end if;
  if jsonb_typeof(p_slots)<>'array' or jsonb_array_length(p_slots)<>11 then return 'Invalid lineup'; end if;
  if jsonb_typeof(p_backups)<>'object' or length(p_backups::text)>2000 then return 'Invalid backups'; end if;
  for s in select * from jsonb_array_elements(p_slots) loop
    w := s->>'want';
    if w is null or w not in ('Batter','Wicketkeeper','All-rounder','Bowler') then return 'Invalid position'; end if;
    if s->>'pid' is not null then
      pid := (s->>'pid')::int;
      if pid = any(pids) then return 'A player can only appear once in the XI'; end if;
      pids := pids || pid;
    end if;
  end loop;
  insert into lineups(franchise_id,room_id,slots,backups,captain,vice,updated_at)
    values(f.id,p_room,p_slots,p_backups,p_captain,p_vice,now())
  on conflict (franchise_id) do update set slots=excluded.slots, backups=excluded.backups, captain=excluded.captain, vice=excluded.vice, updated_at=now();
  return 'ok';
end $$;

-- finalise: only after the auction is over; everything must be real (owned) players
create or replace function lock_lineup(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; l lineups; s jsonb; pids int[] := '{}'; pid int; os int := 0; clean jsonb;
begin
  select * into rm from rooms where id=p_room;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  if rm.status<>'done' then return 'The auction is still running - you can lock your XI when it ends'; end if;
  select * into l from lineups where franchise_id=f.id;
  if l.franchise_id is null then return 'Build your XI first'; end if;
  for s in select * from jsonb_array_elements(l.slots) loop
    if s->>'pid' is null then return 'Fill all 11 slots first'; end if;
    pid := (s->>'pid')::int;
    if pid = any(pids) then return 'A player can only appear once in the XI'; end if;
    if not exists(select 1 from room_players where room_id=p_room and player_id=pid and sold_to=f.id and status='sold')
      then return 'Your XI contains a player your franchise does not own'; end if;
    if (select overseas from players where id=pid) then os := os+1; end if;
    pids := pids || pid;
  end loop;
  if os>4 then return 'Maximum 4 overseas players in the playing XI (you have '||os||')'; end if;
  if l.captain is null or not (l.captain = any(pids)) then return 'Pick a captain from your XI'; end if;
  if l.vice is null or not (l.vice = any(pids)) then return 'Pick a vice-captain from your XI'; end if;
  if l.captain=l.vice then return 'Captain and vice-captain must be different players'; end if;
  -- drop backups that are not owned players outside the XI (e.g. targets that were never bought)
  select coalesce(jsonb_object_agg(e.key, (
      select coalesce(jsonb_agg(v.val), '[]'::jsonb) from jsonb_array_elements_text(e.value) v(val)
      where not (v.val::int = any(pids))
        and exists(select 1 from room_players rp where rp.room_id=p_room and rp.player_id=v.val::int and rp.sold_to=f.id and rp.status='sold'))), '{}'::jsonb)
    into clean from jsonb_each(l.backups) e;
  update lineups set locked=true, backups=clean, updated_at=now() where franchise_id=f.id;
  return 'ok';
end $$;

create or replace function unlock_lineup(p_room uuid) returns text language plpgsql security definer set search_path=public as $$
declare f franchises;
begin
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'Not a participant'; end if;
  update lineups set locked=false, updated_at=now() where franchise_id=f.id;
  return 'ok';
end $$;

do $$ begin alter publication supabase_realtime add table lineups; exception when others then null; end $$;

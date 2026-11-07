-- Run in Supabase SQL Editor (safe to run again, also if you already ran an earlier version of this file).
-- Playing XI + backups, available DURING the auction and finalised at the end.
-- Each franchise has ONE lineup per room: 11 batting-order slots, each with a starter and up to 3 backups, plus captain / vice-captain.
-- Browsers cannot write this table directly; they call save_lineup(), which checks everything on the server:
--   * the auction has started (not the lobby)          * the caller owns a franchise in that room
--   * every starter / backup is a player that franchise has bought so far     * no player twice in the XI
--   * at most 4 overseas players in the XI (official IPL rule)                 * captain and vice-captain must be in the XI
--   * p_final = true (lock it in) only after the auction is over, with 11 starters + captain + vice-captain
-- Privacy: during the auction only the owner can see their own lineup; when the auction is over everyone in the room sees every team's XI.
create table if not exists lineups(
  franchise_id uuid primary key references franchises on delete cascade,
  room_id uuid not null references rooms on delete cascade,
  slots jsonb not null default '[]',      -- [{"p": player_id|null, "b": [backup player ids]}, ...] in batting order
  captain int, vice int,
  final boolean not null default false,
  updated_at timestamptz default now());
alter table lineups add column if not exists final boolean not null default false;
alter table lineups enable row level security;
drop policy if exists p_lineups on lineups;
create policy p_lineups on lineups for select using (
  exists(select 1 from franchises f where f.id=franchise_id and f.user_id=auth.uid())
  or (can_view(room_id) and exists(select 1 from rooms r where r.id=room_id and r.status='done')));

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='lineups') then
    alter publication supabase_realtime add table lineups;
  end if;
end $$;

drop function if exists save_lineup(uuid,jsonb,int,int);
create or replace function save_lineup(p_room uuid, p_slots jsonb, p_captain int default null, p_vice int default null, p_final boolean default false) returns text
language plpgsql security definer set search_path=public as $$
declare rm rooms; f franchises; s jsonb; pid int; b text; xi int[] := '{}'; os int := 0; nb int;
begin
  if auth.uid() is null then return 'Not signed in'; end if;
  select * into rm from rooms where id=p_room;
  if rm.id is null then return 'Room not found'; end if;
  if rm.status not in ('live','paused','review','done') then return 'Playing XI opens when the auction starts'; end if;
  select * into f from franchises where room_id=p_room and user_id=auth.uid();
  if f.id is null then return 'You do not own a team in this room'; end if;
  if jsonb_typeof(p_slots)<>'array' or jsonb_array_length(p_slots)>11 then return 'Invalid lineup'; end if;

  -- pass 1: starters
  for s in select * from jsonb_array_elements(p_slots) loop
    pid := nullif(s->>'p','')::int;
    if pid is null then continue; end if;
    if pid = any(xi) then return 'A player is in the XI twice'; end if;
    if not exists(select 1 from room_players where room_id=p_room and player_id=pid and sold_to=f.id and status='sold') then
      return 'You can only pick players your team bought'; end if;
    xi := xi || pid;
    if (select overseas from players where id=pid) then os := os + 1; end if;
  end loop;
  if os > 4 then return 'Max 4 overseas players in the playing XI'; end if;

  -- pass 2: backups
  for s in select * from jsonb_array_elements(p_slots) loop
    nb := 0;
    for b in select * from jsonb_array_elements_text(coalesce(s->'b','[]'::jsonb)) loop
      nb := nb + 1;
      if nb > 3 then return 'Max 3 backups per position'; end if;
      if b::int = any(xi) then return 'A backup cannot also be in the XI'; end if;
      if not exists(select 1 from room_players where room_id=p_room and player_id=b::int and sold_to=f.id and status='sold') then
        return 'You can only pick players your team bought'; end if;
    end loop;
  end loop;

  if p_captain is not null and not (p_captain = any(xi)) then return 'Captain must be in the XI'; end if;
  if p_vice is not null and not (p_vice = any(xi)) then return 'Vice-captain must be in the XI'; end if;
  if p_captain is not null and p_captain = p_vice then return 'Captain and vice-captain must be different players'; end if;
  if p_final then
    if rm.status<>'done' then return 'You can finalise your XI after the auction is over'; end if;
    if coalesce(array_length(xi,1),0)<>11 then return 'Pick all 11 players before finalising'; end if;
    if p_captain is null or p_vice is null then return 'Choose a captain and a vice-captain before finalising'; end if;
  end if;

  insert into lineups(franchise_id,room_id,slots,captain,vice,final,updated_at) values(f.id,p_room,p_slots,p_captain,p_vice,coalesce(p_final,false),now())
  on conflict (franchise_id) do update set slots=excluded.slots, captain=excluded.captain, vice=excluded.vice, final=excluded.final, updated_at=now();
  return 'ok';
end $$;

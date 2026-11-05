-- Run ONCE in Supabase SQL Editor. Recovery PIN: lets a player (or the host) take back their franchise on a new device/browser.
-- PINs live in a private table that browsers cannot read directly; only the owner can fetch their own PIN via get_my_pin().
create table if not exists franchise_pins(franchise_id uuid primary key references franchises on delete cascade, pin text not null);
create table if not exists pin_fail(id bigserial primary key, franchise_id uuid, at timestamptz default now());
alter table franchise_pins enable row level security;
alter table pin_fail enable row level security;
revoke all on franchise_pins, pin_fail from anon, authenticated;

create or replace function _make_pin() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into franchise_pins(franchise_id,pin) values(new.id, lpad((floor(random()*1000000))::int::text,6,'0')) on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_make_pin on franchises;
create trigger trg_make_pin after insert on franchises for each row when (new.user_id is not null) execute function _make_pin();

-- give every existing human franchise a PIN too
insert into franchise_pins(franchise_id,pin)
  select id, lpad((floor(random()*1000000))::int::text,6,'0') from franchises where user_id is not null on conflict do nothing;

create or replace function get_my_pin(p_room uuid) returns text language sql security definer set search_path=public as $$
  select p.pin from franchise_pins p join franchises f on f.id=p.franchise_id where f.room_id=p_room and f.user_id=auth.uid() $$;

create or replace function recover_franchise(p_code text, p_team text, p_pin text) returns text
language plpgsql security definer set search_path=public as $$
declare r rooms; f franchises;
begin
  if auth.uid() is null then return 'Not signed in'; end if;
  select * into r from rooms where code=upper(btrim(p_code));
  if r.id is null then return 'Room not found'; end if;
  select * into f from franchises where room_id=r.id and lower(team)=lower(btrim(p_team)) and not coalesce(is_bot,false);
  if f.id is null then return 'No human team with that name in this room'; end if;
  if f.user_id=auth.uid() then return 'ok'; end if;
  if exists(select 1 from franchises where room_id=r.id and user_id=auth.uid()) then return 'This browser already owns a team in this room'; end if;
  if (select count(*) from pin_fail where franchise_id=f.id and at>now()-interval '10 minutes')>=8 then
    return 'Too many wrong attempts. Wait 10 minutes and try again.'; end if;
  if not exists(select 1 from franchise_pins where franchise_id=f.id and pin=btrim(p_pin)) then
    insert into pin_fail(franchise_id) values(f.id); return 'Wrong PIN'; end if;
  if r.host_id=f.user_id then update rooms set host_id=auth.uid() where id=r.id; end if;   -- host recovers host controls too
  update franchises set user_id=auth.uid() where id=f.id;
  insert into audit(room_id,actor,action,detail) values(r.id,auth.uid(),'recover_franchise',jsonb_build_object('team',f.team));
  return 'ok';
end $$;

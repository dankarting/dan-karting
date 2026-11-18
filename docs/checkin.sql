-- Dan Karting: customer check-in with a phone number (QR at the counter -> ?join page).
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run. Safe to run again.
--
-- Privacy: the public page can NOT read these tables. It only calls two functions:
--   checkin_lookup(phone)  -> the saved first names for that phone, shortened ("דני כ.")
--   checkin_submit(...)    -> adds a check-in for the cashier and remembers new names for next time
-- Signed-in staff read the check-ins and the customer list. No ID numbers are stored.

-- 1) Customers: one row per phone number, with the names that came with it.
create table if not exists public.drivers (
  phone      text primary key,                  -- digits only, e.g. 0521234567
  names      text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     int not null default 0
);
alter table public.drivers enable row level security;
drop policy if exists "staff read drivers" on public.drivers;
create policy "staff read drivers" on public.drivers for select to authenticated using (true);
drop policy if exists "staff edit drivers" on public.drivers;
create policy "staff edit drivers" on public.drivers for update to authenticated using (true) with check (true);
drop policy if exists "staff delete drivers" on public.drivers;
create policy "staff delete drivers" on public.drivers for delete to authenticated using (true);

-- 2) Check-ins waiting for a staff computer to pick them up into "ממתינים לתשלום".
create table if not exists public.checkins (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  phone    text not null,
  names    text[] not null,
  minutes  int not null default 10,
  claimed  boolean not null default false
);
create index if not exists checkins_open on public.checkins (claimed, at);
alter table public.checkins enable row level security;
drop policy if exists "staff read checkins" on public.checkins;
create policy "staff read checkins" on public.checkins for select to authenticated using (true);
drop policy if exists "staff update checkins" on public.checkins;
create policy "staff update checkins" on public.checkins for update to authenticated using (true) with check (true);
do $$ begin
  alter publication supabase_realtime add table public.checkins;
exception when duplicate_object then null; end $$;

-- 3) Public: saved names for a phone, shortened (first name + first letter of the family name).
create or replace function public.checkin_lookup(p_phone text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((
    select array_agg(split_part(n, ' ', 1) || case when position(' ' in n) > 0 then ' ' || left(split_part(n, ' ', 2), 1) || '.' else '' end order by i)
    from drivers d, unnest(d.names) with ordinality as u(n, i)
    where d.phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
  ), '{}');
$$;

-- 4) Public: check in. p_pick = positions (1-based) of saved names that are coming, p_new = new names typed now.
create or replace function public.checkin_submit(p_phone text, p_pick int[], p_new text[], p_minutes int)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  ph    text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  saved text[];
  fresh text[];
  going text[];
  nid   bigint;
begin
  if ph !~ '^0[0-9]{8,9}$' then raise exception 'bad phone'; end if;
  select names into saved from drivers where phone = ph;
  saved := coalesce(saved, '{}');
  select coalesce(array_agg(x), '{}') into fresh from (
    select distinct on (lower(t)) t as x
    from (select left(btrim(regexp_replace(n, '\s+', ' ', 'g')), 24) as t from unnest(coalesce(p_new, '{}')) n) a
    where t <> '' and not (lower(t) = any (select lower(s) from unnest(saved) s))
  ) b;
  select coalesce(array_agg(saved[i] order by i), '{}') into going
    from unnest(coalesce(p_pick, '{}')) i where i between 1 and coalesce(array_length(saved, 1), 0);
  going := going || fresh;
  if coalesce(array_length(going, 1), 0) = 0 then raise exception 'no names'; end if;
  if array_length(going, 1) > 20 or coalesce(array_length(saved, 1), 0) + coalesce(array_length(fresh, 1), 0) > 40 then raise exception 'too many names'; end if;
  -- the same phone twice within a minute: keep the first one
  if exists (select 1 from checkins where phone = ph and at > now() - interval '1 minute') then raise exception 'too soon'; end if;
  insert into drivers (phone, names, visits) values (ph, fresh, 1)
    on conflict (phone) do update set names = drivers.names || fresh, last_seen = now(), visits = drivers.visits + 1;
  insert into checkins (phone, names, minutes) values (ph, going, case when p_minutes >= 20 then 20 else 10 end) returning id into nid;
  return nid;
end $$;

-- 5) Staff: take every open check-in exactly once (two staff computers never both take the same one).
create or replace function public.checkin_claim()
returns setof public.checkins language sql volatile security invoker set search_path = public as $$
  update checkins set claimed = true where id in (
    select id from checkins where not claimed order by at for update skip locked
  ) returning *;
$$;

revoke all on function public.checkin_lookup(text) from public;
revoke all on function public.checkin_submit(text, int[], text[], int) from public;
revoke all on function public.checkin_claim() from public;
grant execute on function public.checkin_lookup(text) to anon, authenticated;
grant execute on function public.checkin_submit(text, int[], text[], int) to anon, authenticated;
grant execute on function public.checkin_claim() to authenticated;

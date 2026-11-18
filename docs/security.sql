-- Dan Karting: security hardening. Run once AFTER the earlier files. Safe to run again.
-- Supabase -> SQL Editor -> New query -> paste all -> Run. The last query prints a check table (all rows should say OK).
--
-- What this does:
--  1. Staff = an explicit list (public.staff_users), not "anyone who is signed in". Even if someone manages to create an
--     account (sign-ups switched on by mistake), they get nothing.
--  2. Every staff table: readable / writable by staff only. The public site can only read the board and finished heats.
--  3. Removes the old phone / SMS check-in functions (the page now uses the ID number).
--  4. Limits how fast strangers can use the two public check-in functions (stops floods and guessing ID numbers).

-- 1) Staff list: every account that exists right now is staff (only the owner could create accounts so far).
create table if not exists public.staff_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email   text,
  added   timestamptz not null default now()
);
alter table public.staff_users enable row level security;
drop policy if exists "staff see own row" on public.staff_users;
create policy "staff see own row" on public.staff_users for select to authenticated using (user_id = auth.uid());
insert into public.staff_users (user_id, email) select id, email from auth.users on conflict (user_id) do nothing;
-- To add a NEW staff member later: create the user in Authentication -> Users, then run (with their user name):
--   insert into public.staff_users (user_id, email) select id, email from auth.users where email = 'NAME@dankarting.app';
-- To remove one: delete from public.staff_users where email = 'NAME@dankarting.app';

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_users where user_id = auth.uid());
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated;

-- 2) Staff tables: staff only. Drop every existing policy first so nothing older stays open.
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public'
           and tablename in ('live_board','staff_state','heat_history','drivers','checkins','id_customers','customers','checkin_sms','checkin_codes','checkin_secret')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- the public board: everyone reads, staff update
alter table public.live_board enable row level security;
create policy "public can read board" on public.live_board for select to anon, authenticated using (true);
create policy "staff can update board" on public.live_board for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- finished heats: everyone reads, staff add
alter table public.heat_history enable row level security;
create policy "public can read history" on public.heat_history for select to anon, authenticated using (true);
create policy "staff can add history" on public.heat_history for insert to authenticated with check (public.is_staff());
-- shared staff state (registrations, queue, heats): staff only
alter table public.staff_state enable row level security;
create policy "staff read state" on public.staff_state for select to authenticated using (public.is_staff());
create policy "staff write state" on public.staff_state for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- check-ins waiting at the cashier: staff only (the public adds them only through checkin_submit_id)
alter table public.checkins enable row level security;
create policy "staff read checkins" on public.checkins for select to authenticated using (public.is_staff());
create policy "staff update checkins" on public.checkins for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- returning customers (ID fingerprints + names): staff read only
alter table public.id_customers enable row level security;
create policy "staff read id customers" on public.id_customers for select to authenticated using (public.is_staff());
-- old phone customers table, SMS settings, codes, salt: no policies at all = closed to the website, staff included
do $$ begin
  if to_regclass('public.drivers') is not null then execute 'alter table public.drivers enable row level security'; end if;
  if to_regclass('public.checkin_sms') is not null then execute 'alter table public.checkin_sms enable row level security'; end if;
  if to_regclass('public.checkin_codes') is not null then execute 'alter table public.checkin_codes enable row level security'; end if;
end $$;
alter table public.checkin_secret enable row level security;

-- 3) Old phone / SMS functions are not used any more: remove them.
drop function if exists public.checkin_lookup(text);
drop function if exists public.checkin_lookup(text, text);
drop function if exists public.checkin_submit(text, int[], text[], int);
drop function if exists public.checkin_submit(text, int[], text[], int, text);
drop function if exists public.checkin_send_code(text);
drop function if exists public.checkin_verify(text, text);
drop function if exists public.checkin_pass_ok(text, text);

-- Staff: take open check-ins (staff only).
create or replace function public.checkin_claim()
returns setof public.checkins language plpgsql volatile security invoker set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'staff only'; end if;
  return query update checkins set claimed = true where id in (
    select id from checkins where not claimed order by at for update skip locked
  ) returning *;
end $$;
revoke all on function public.checkin_claim() from public, anon;
grant execute on function public.checkin_claim() to authenticated;

-- 4) Rate limits for the two public functions (whole site, since the database cannot see who is calling).
create table if not exists public.checkin_rate (
  id   bigserial primary key,
  at   timestamptz not null default now(),
  kind text not null
);
create index if not exists checkin_rate_at on public.checkin_rate (kind, at);
alter table public.checkin_rate enable row level security;

create or replace function public.checkin_throttle(p_kind text, p_max int, p_window interval) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  delete from checkin_rate where at < now() - interval '1 hour';
  if (select count(*) from checkin_rate where kind = p_kind and at > now() - p_window) >= p_max then
    raise exception 'busy';
  end if;
  insert into checkin_rate (kind) values (p_kind);
end $$;
revoke all on function public.checkin_throttle(text, int, interval) from public, anon, authenticated;

-- lookup: at most 120 in 5 minutes for the whole venue (a busy evening uses far less); stops guessing ID numbers
create or replace function public.checkin_lookup_id(p_tz text)
returns text[] language plpgsql volatile security definer set search_path = public as $$
declare t text := lpad(regexp_replace(coalesce(p_tz, ''), '\D', '', 'g'), 9, '0');
begin
  if not tz_ok(t) then raise exception 'bad id'; end if;
  perform checkin_throttle('lookup', 120, interval '5 minutes');
  return coalesce((
    select array_agg(split_part(n, ' ', 1) || case when position(' ' in n) > 0 then ' ' || left(split_part(n, ' ', 2), 1) || '.' else '' end order by i)
    from id_customers c, unnest(c.names) with ordinality as u(n, i)
    where c.id_hash = tz_hash(t)
  ), '{}');
end $$;

-- submit: at most 60 in 5 minutes for the whole venue, one per ID per minute (stops flooding the cashier list)
create or replace function public.checkin_submit_id(p_tz text, p_pick int[], p_new text[], p_minutes int)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  t     text := lpad(regexp_replace(coalesce(p_tz, ''), '\D', '', 'g'), 9, '0');
  h     text;
  saved text[];
  fresh text[];
  going text[];
  nid   bigint;
begin
  if not tz_ok(t) then raise exception 'bad id'; end if;
  h := tz_hash(t);
  if exists (select 1 from checkins where id_hash = h and at > now() - interval '1 minute') then raise exception 'too soon'; end if;
  perform checkin_throttle('submit', 60, interval '5 minutes');
  select names into saved from id_customers where id_hash = h;
  saved := coalesce(saved, '{}');
  select coalesce(array_agg(x), '{}') into fresh from (
    select distinct on (lower(s0)) s0 as x
    from (select left(btrim(regexp_replace(n, '[\s<>]+', ' ', 'g')), 24) as s0 from unnest(coalesce(p_new, '{}')) n) a
    where s0 <> '' and not (lower(s0) = any (select lower(s) from unnest(saved) s))
  ) b;
  select coalesce(array_agg(saved[i] order by i), '{}') into going
    from unnest(coalesce(p_pick, '{}')) i where i between 1 and coalesce(array_length(saved, 1), 0);
  going := going || fresh;
  if coalesce(array_length(going, 1), 0) = 0 then raise exception 'no names'; end if;
  if array_length(going, 1) > 5 or coalesce(array_length(saved, 1), 0) + coalesce(array_length(fresh, 1), 0) > 10 then raise exception 'too many names'; end if;
  insert into id_customers (id_hash, names, visits) values (h, fresh, 1)
    on conflict (id_hash) do update set names = id_customers.names || fresh, last_seen = now(), visits = id_customers.visits + 1;
  insert into checkins (phone, id_hash, tz_tail, names, minutes) values ('', h, right(t, 3), going, case when p_minutes >= 20 then 20 else 10 end) returning id into nid;
  return nid;
end $$;

revoke all on function public.checkin_lookup_id(text) from public;
revoke all on function public.checkin_submit_id(text, int[], text[], int) from public;
grant execute on function public.checkin_lookup_id(text) to anon, authenticated;
grant execute on function public.checkin_submit_id(text, int[], text[], int) to anon, authenticated;
revoke all on function public.tz_hash(text) from public, anon, authenticated;

-- 5) Check table: every row should say OK.
select item, case when ok then 'OK' else 'PROBLEM' end as result from (
  select 'staff accounts on the list: ' || (select count(*) from public.staff_users)::text as item, (select count(*) from public.staff_users) > 0 as ok
  union all
  select 'RLS on: ' || c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 'policy open to anon: ' || tablename || ' / ' || policyname || ' (' || cmd || ')',
         (cmd = 'SELECT' and tablename in ('live_board', 'heat_history'))
    from pg_policies where schemaname = 'public' and 'anon' = any (roles)
  union all
  select 'policy for signed-in without staff check: ' || tablename || ' / ' || policyname, false
    from pg_policies where schemaname = 'public' and 'authenticated' = any (roles)
      and coalesce(qual, '') not like '%is_staff%' and coalesce(with_check, '') not like '%is_staff%'
      and not (cmd = 'SELECT' and tablename in ('live_board', 'heat_history'))
      and not (tablename = 'staff_users' and coalesce(qual, '') like '%auth.uid()%')
  union all
  select 'public function: ' || p.proname, p.proname in ('checkin_lookup_id', 'checkin_submit_id', 'is_staff')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in ('tz_ok', 'checkin_norm')
) x order by ok, item;

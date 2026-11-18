-- Dan Karting: customer check-in with Google (QR at the counter -> ?join page) + staff-only permissions.
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run. Safe to run again.
-- IMPORTANT: run this BEFORE turning on Google sign-in / new sign-ups in Supabase.
--
-- Why part 0: until now every signed-in account was staff (sign-ups were closed). Customers will now sign in with
-- Google, so "signed in" no longer means "staff". Staff = the accounts listed in public.staff_users.

-- 0) Staff list. Every account that exists right now (before customers can sign in) is staff.
create table if not exists public.staff_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email   text,
  added   timestamptz not null default now()
);
alter table public.staff_users enable row level security;
drop policy if exists "staff see own row" on public.staff_users;
create policy "staff see own row" on public.staff_users for select to authenticated using (user_id = auth.uid());
insert into public.staff_users (user_id, email)
  select id, email from auth.users
  where not exists (select 1 from auth.identities i where i.user_id = auth.users.id and i.provider = 'google')
on conflict (user_id) do nothing;
-- To add a NEW staff member later: create the user in Authentication -> Users, then run (with their user name):
--   insert into public.staff_users (user_id, email) select id, email from auth.users where email = 'NAME@dankarting.app';

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_users where user_id = auth.uid());
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated;

-- Existing staff tables: from "any signed-in account" to "staff only".
drop policy if exists "staff can update board" on public.live_board;
create policy "staff can update board" on public.live_board for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff read state" on public.staff_state;
create policy "staff read state" on public.staff_state for select to authenticated using (public.is_staff());
drop policy if exists "staff write state" on public.staff_state;
create policy "staff write state" on public.staff_state for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff can add history" on public.heat_history;
create policy "staff can add history" on public.heat_history for insert to authenticated with check (public.is_staff());

-- 1) Customers: one row per Google account, with the names that came with it (the customer, kids, friends).
drop function if exists public.checkin_lookup(text);
drop function if exists public.checkin_submit(text, int[], text[], int);
create table if not exists public.customers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  names      text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     int not null default 0
);
alter table public.customers enable row level security;
drop policy if exists "staff read customers" on public.customers;
create policy "staff read customers" on public.customers for select to authenticated using (public.is_staff());
drop policy if exists "staff edit customers" on public.customers;
create policy "staff edit customers" on public.customers for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete customers" on public.customers;
create policy "staff delete customers" on public.customers for delete to authenticated using (public.is_staff());

-- 2) Check-ins waiting for a staff computer to pick them up into "ממתינים לתשלום".
create table if not exists public.checkins (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  phone    text not null default '',
  names    text[] not null,
  minutes  int not null default 10,
  claimed  boolean not null default false
);
alter table public.checkins alter column phone set default '';
alter table public.checkins add column if not exists user_id uuid;
alter table public.checkins add column if not exists email text;
create index if not exists checkins_open on public.checkins (claimed, at);
alter table public.checkins enable row level security;
drop policy if exists "staff read checkins" on public.checkins;
create policy "staff read checkins" on public.checkins for select to authenticated using (public.is_staff());
drop policy if exists "staff update checkins" on public.checkins;
create policy "staff update checkins" on public.checkins for update to authenticated using (public.is_staff()) with check (public.is_staff());
do $$ begin
  alter publication supabase_realtime add table public.checkins;
exception when duplicate_object then null; end $$;

-- 3) Signed-in customer: my saved names.
create or replace function public.checkin_me()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((select names from customers where user_id = auth.uid()), '{}');
$$;

-- 4) Signed-in customer: check in. p_pick = positions (1-based) of saved names coming, p_new = names typed now.
create or replace function public.checkin_submit(p_pick int[], p_new text[], p_minutes int)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  mail  text;
  saved text[];
  fresh text[];
  going text[];
  nid   bigint;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select email into mail from auth.users where id = uid;
  select names into saved from customers where user_id = uid;
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
  if exists (select 1 from checkins where user_id = uid and at > now() - interval '1 minute') then raise exception 'too soon'; end if;
  insert into customers (user_id, email, names, visits) values (uid, mail, fresh, 1)
    on conflict (user_id) do update set names = customers.names || fresh, email = mail, last_seen = now(), visits = customers.visits + 1;
  insert into checkins (user_id, email, names, minutes) values (uid, mail, going, case when p_minutes >= 20 then 20 else 10 end) returning id into nid;
  return nid;
end $$;

-- 5) Staff: take every open check-in exactly once (two staff computers never both take the same one).
create or replace function public.checkin_claim()
returns setof public.checkins language sql volatile security invoker set search_path = public as $$
  update checkins set claimed = true where id in (
    select id from checkins where not claimed order by at for update skip locked
  ) returning *;
$$;

revoke all on function public.checkin_me() from public;
revoke all on function public.checkin_submit(int[], text[], int) from public;
revoke all on function public.checkin_claim() from public;
grant execute on function public.checkin_me() to authenticated;
grant execute on function public.checkin_submit(int[], text[], int) to authenticated;
grant execute on function public.checkin_claim() to authenticated;

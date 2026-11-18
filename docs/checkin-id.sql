-- Dan Karting: check-in with an ID number (ת"ז) instead of a phone. Run AFTER checkin-all.sql (already done).
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run. Safe to run again.
--
-- The ID number is NEVER stored. The database keeps only a fingerprint (sha256 of the number + a secret salt that
-- exists only in this database), which cannot be turned back into the number. The cashier sees only the last 3 digits.

-- 1) Secret salt, made once. No policies = nobody can read it through the website.
create table if not exists public.checkin_secret (
  id   int primary key default 1 check (id = 1),
  salt text not null default gen_random_uuid()::text
);
insert into public.checkin_secret (id) values (1) on conflict (id) do nothing;
alter table public.checkin_secret enable row level security;

-- 2) Customers by ID fingerprint.
create table if not exists public.id_customers (
  id_hash    text primary key,
  names      text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     int not null default 0
);
alter table public.id_customers enable row level security;
drop policy if exists "staff read id customers" on public.id_customers;
create policy "staff read id customers" on public.id_customers for select to authenticated using (true);

alter table public.checkins add column if not exists tz_tail text;
alter table public.checkins add column if not exists id_hash text;
alter table public.checkins alter column phone set default '';

-- 3) Helpers: valid Israeli ID (check digit) and its fingerprint.
create or replace function public.tz_ok(t text) returns boolean language plpgsql immutable as $$
declare s int := 0; n int; i int;
begin
  if t !~ '^[0-9]{9}$' or t = '000000000' then return false; end if;
  for i in 1..9 loop
    n := substr(t, i, 1)::int * (case when i % 2 = 0 then 2 else 1 end);
    if n > 9 then n := n - 9; end if;
    s := s + n;
  end loop;
  return s % 10 = 0;
end $$;

create or replace function public.tz_hash(t text) returns text language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to((select salt from checkin_secret where id = 1) || ':' || t, 'UTF8')), 'hex');
$$;
revoke all on function public.tz_hash(text) from public, anon, authenticated;

-- 4) Public: saved names for an ID, shortened ("דני כ.").
create or replace function public.checkin_lookup_id(p_tz text)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare t text := lpad(regexp_replace(coalesce(p_tz, ''), '\D', '', 'g'), 9, '0');
begin
  if not tz_ok(t) then raise exception 'bad id'; end if;
  return coalesce((
    select array_agg(split_part(n, ' ', 1) || case when position(' ' in n) > 0 then ' ' || left(split_part(n, ' ', 2), 1) || '.' else '' end order by i)
    from id_customers c, unnest(c.names) with ordinality as u(n, i)
    where c.id_hash = tz_hash(t)
  ), '{}');
end $$;

-- 5) Public: check in with an ID. p_pick = positions (1-based) of saved names coming, p_new = names typed now.
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
  select names into saved from id_customers where id_hash = h;
  saved := coalesce(saved, '{}');
  select coalesce(array_agg(x), '{}') into fresh from (
    select distinct on (lower(s0)) s0 as x
    from (select left(btrim(regexp_replace(n, '\s+', ' ', 'g')), 24) as s0 from unnest(coalesce(p_new, '{}')) n) a
    where s0 <> '' and not (lower(s0) = any (select lower(s) from unnest(saved) s))
  ) b;
  select coalesce(array_agg(saved[i] order by i), '{}') into going
    from unnest(coalesce(p_pick, '{}')) i where i between 1 and coalesce(array_length(saved, 1), 0);
  going := going || fresh;
  if coalesce(array_length(going, 1), 0) = 0 then raise exception 'no names'; end if;
  if array_length(going, 1) > 20 or coalesce(array_length(saved, 1), 0) + coalesce(array_length(fresh, 1), 0) > 40 then raise exception 'too many names'; end if;
  if exists (select 1 from checkins where id_hash = h and at > now() - interval '1 minute') then raise exception 'too soon'; end if;
  insert into id_customers (id_hash, names, visits) values (h, fresh, 1)
    on conflict (id_hash) do update set names = id_customers.names || fresh, last_seen = now(), visits = id_customers.visits + 1;
  insert into checkins (phone, id_hash, tz_tail, names, minutes) values ('', h, right(t, 3), going, case when p_minutes >= 20 then 20 else 10 end) returning id into nid;
  return nid;
end $$;

revoke all on function public.checkin_lookup_id(text) from public;
revoke all on function public.checkin_submit_id(text, int[], text[], int) from public;
grant execute on function public.checkin_lookup_id(text) to anon, authenticated;
grant execute on function public.checkin_submit_id(text, int[], text[], int) to anon, authenticated;

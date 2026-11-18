-- Dan Karting: phone check-in + SMS code, everything in one file. Paste ALL of it into Supabase SQL Editor and Run.

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
-- Dan Karting: SMS verification code for the phone check-in page (?join). Run AFTER docs/checkin.sql.
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run. Safe to run again.
--
-- Codes are sent from the venue's own Android phone with the httpSMS app (https://httpsms.com).
-- Until the key is filled in (step 5 at the bottom), the page works WITHOUT a code, exactly as before.
-- The key lives only in this database (a table nobody can read through the website).

create extension if not exists pg_net;

-- 1) Settings for sending (one row). No policies = not readable or writable from the website at all.
create table if not exists public.checkin_sms (
  id       int primary key default 1 check (id = 1),
  api_key  text,
  sender   text,                       -- the venue phone in international form, e.g. +972521234567
  enabled  boolean not null default false
);
insert into public.checkin_sms (id) values (1) on conflict (id) do nothing;
alter table public.checkin_sms enable row level security;

-- 2) Codes and "verified today" passes. Also closed to the website.
create table if not exists public.checkin_codes (
  phone     text primary key,
  code_hash text,
  expires   timestamptz,
  tries     int not null default 0,
  sent_at   timestamptz,
  pass_hash text,
  pass_until timestamptz
);
alter table public.checkin_codes enable row level security;

create or replace function public.checkin_norm(p text) returns text language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '\D', '', 'g');
$$;

-- true when this phone may continue: SMS is off, or the phone has a valid pass (from a code typed in the last 12 h).
create or replace function public.checkin_pass_ok(ph text, p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select enabled and api_key is not null and sender is not null from checkin_sms where id = 1), false)
      or exists (select 1 from checkin_codes c where c.phone = ph and c.pass_until > now() and c.pass_hash = md5(coalesce(p_token, '') || ph));
$$;

-- 3) Send a code. Returns 'off' (SMS not set up: continue without a code) or 'sent'.
create or replace function public.checkin_send_code(p_phone text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  ph   text := checkin_norm(p_phone);
  cfg  checkin_sms;
  code text;
begin
  if ph !~ '^05[0-9]{8}$' then raise exception 'bad phone'; end if;
  select * into cfg from checkin_sms where id = 1;
  if not coalesce(cfg.enabled and cfg.api_key is not null and cfg.sender is not null, false) then return 'off'; end if;
  if exists (select 1 from checkin_codes where phone = ph and sent_at > now() - interval '60 seconds') then raise exception 'wait'; end if;
  -- guard against someone flooding random numbers: at most 40 codes in 10 minutes for the whole venue
  if (select count(*) from checkin_codes where sent_at > now() - interval '10 minutes') >= 40 then raise exception 'busy'; end if;
  code := lpad(floor(random() * 10000)::int::text, 4, '0');
  insert into checkin_codes (phone, code_hash, expires, tries, sent_at) values (ph, md5(code || ph), now() + interval '10 minutes', 0, now())
    on conflict (phone) do update set code_hash = excluded.code_hash, expires = excluded.expires, tries = 0, sent_at = now();
  perform net.http_post(
    url := 'https://api.httpsms.com/v1/messages/send',
    headers := jsonb_build_object('x-api-key', cfg.api_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', cfg.sender, 'to', '+972' || substr(ph, 2), 'content', 'דן קארטינג - קוד ההרשמה שלך: ' || code)
  );
  return 'sent';
end $$;

-- 4) Check a code. Returns a pass (kept on the customer's phone for 12 h), or raises 'wrong code' / 'expired'.
create or replace function public.checkin_verify(p_phone text, p_code text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  ph  text := checkin_norm(p_phone);
  row checkin_codes;
  tok text;
begin
  select * into row from checkin_codes where phone = ph;
  if row.phone is null or row.code_hash is null or row.expires < now() then raise exception 'expired'; end if;
  if row.tries >= 5 then raise exception 'expired'; end if;
  if md5(coalesce(btrim(p_code), '') || ph) <> row.code_hash then
    update checkin_codes set tries = tries + 1 where phone = ph;
    raise exception 'wrong code';
  end if;
  tok := gen_random_uuid()::text;
  update checkin_codes set code_hash = null, pass_hash = md5(tok || ph), pass_until = now() + interval '12 hours' where phone = ph;
  return tok;
end $$;

-- Lookup and submit now take the pass. Without SMS set up, no pass is needed (same as before).
drop function if exists public.checkin_lookup(text);
drop function if exists public.checkin_submit(text, int[], text[], int);

create or replace function public.checkin_lookup(p_phone text, p_token text default null)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare ph text := checkin_norm(p_phone);
begin
  if not checkin_pass_ok(ph, p_token) then raise exception 'need code'; end if;
  return coalesce((
    select array_agg(split_part(n, ' ', 1) || case when position(' ' in n) > 0 then ' ' || left(split_part(n, ' ', 2), 1) || '.' else '' end order by i)
    from drivers d, unnest(d.names) with ordinality as u(n, i)
    where d.phone = ph
  ), '{}');
end $$;

create or replace function public.checkin_submit(p_phone text, p_pick int[], p_new text[], p_minutes int, p_token text default null)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  ph    text := checkin_norm(p_phone);
  saved text[];
  fresh text[];
  going text[];
  nid   bigint;
begin
  if ph !~ '^0[0-9]{8,9}$' then raise exception 'bad phone'; end if;
  if not checkin_pass_ok(ph, p_token) then raise exception 'need code'; end if;
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
  if exists (select 1 from checkins where phone = ph and at > now() - interval '1 minute') then raise exception 'too soon'; end if;
  insert into drivers (phone, names, visits) values (ph, fresh, 1)
    on conflict (phone) do update set names = drivers.names || fresh, last_seen = now(), visits = drivers.visits + 1;
  insert into checkins (phone, names, minutes) values (ph, going, case when p_minutes >= 20 then 20 else 10 end) returning id into nid;
  return nid;
end $$;

revoke all on function public.checkin_pass_ok(text, text) from public, anon, authenticated;
revoke all on function public.checkin_send_code(text) from public;
revoke all on function public.checkin_verify(text, text) from public;
revoke all on function public.checkin_lookup(text, text) from public;
revoke all on function public.checkin_submit(text, int[], text[], int, text) from public;
grant execute on function public.checkin_send_code(text) to anon, authenticated;
grant execute on function public.checkin_verify(text, text) to anon, authenticated;
grant execute on function public.checkin_lookup(text, text) to anon, authenticated;
grant execute on function public.checkin_submit(text, int[], text[], int, text) to anon, authenticated;

-- 5) Turn SMS on: put the httpSMS API key and the venue phone below, remove the two dashes at the start of the line, Run.
-- update public.checkin_sms set api_key = 'PASTE-THE-KEY-HERE', sender = '+9725XXXXXXXX', enabled = true where id = 1;
-- To turn it off again (page works without a code):
-- update public.checkin_sms set enabled = false where id = 1;

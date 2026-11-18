-- Dan Karting: every customer's rides (best lap, history) for the customers' area. Run AFTER security.sql. Safe to run again.
-- Supabase -> SQL Editor -> New query -> paste all -> Run.
--
-- A ride is saved by the staff computer when a heat is saved, for drivers who checked in with their ID.
-- Rides are keyed by the ID fingerprint (never the ID number). Strangers cannot read the table; a customer sees
-- their own rides only by typing their ID number on the site (rate limited, like the check-in).

create table if not exists public.rides (
  id       text primary key,                 -- heat + time + driver: saving the same heat twice adds nothing
  id_hash  text not null,
  at       timestamptz not null,
  heat_num int,
  minutes  int,
  kart     int,
  pos      int,
  of_n     int,
  best_ms  int,
  laps     int,
  total_ms int
);
create index if not exists rides_by_customer on public.rides (id_hash, at desc);
alter table public.rides enable row level security;
drop policy if exists "staff add rides" on public.rides;
create policy "staff add rides" on public.rides for insert to authenticated with check (public.is_staff());
drop policy if exists "staff read rides" on public.rides;
create policy "staff read rides" on public.rides for select to authenticated using (public.is_staff());

-- The cashier's copy of a check-in carries the ID fingerprint, so the staff computer can file the ride under it.
-- (checkin_claim already returns every column of checkins, including id_hash.)

-- Public: my name, best lap and rides, by ID number.
create or replace function public.my_rides(p_tz text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  t text := lpad(regexp_replace(coalesce(p_tz, ''), '\D', '', 'g'), 9, '0');
  h text;
  nm text;
begin
  if not tz_ok(t) then raise exception 'bad id'; end if;
  perform checkin_throttle('lookup', 120, interval '5 minutes');
  h := tz_hash(t);
  select names[1] into nm from id_customers where id_hash = h;
  if nm is null then return jsonb_build_object('known', false); end if;
  return jsonb_build_object(
    'known', true,
    'name', split_part(nm, ' ', 1) || case when position(' ' in nm) > 0 then ' ' || left(split_part(nm, ' ', 2), 1) || '.' else '' end,
    'visits', (select visits from id_customers where id_hash = h),
    'best', (select min(best_ms) from rides where id_hash = h and best_ms > 0),
    'rides', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'heat', heat_num, 'minutes', minutes, 'kart', kart, 'pos', pos, 'of', of_n, 'best', best_ms, 'laps', laps) order by at desc)
                       from (select * from rides where id_hash = h order by at desc limit 100) r), '[]'::jsonb)
  );
end $$;
revoke all on function public.my_rides(text) from public;
grant execute on function public.my_rides(text) to anon, authenticated;

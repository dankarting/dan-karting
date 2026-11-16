-- Dan Karting: one shared state for all staff computers (forms, cashier, queue, heats, track, history).
-- Run once: Supabase -> SQL Editor -> New query -> paste all -> Run. Safe to run again.

-- 1) Shared staff state: only signed-in staff can read or write it (unpaid sign-ups stay private).
create table if not exists public.staff_state (
  id         text primary key,                 -- 'core' (sign-ups, queue, heats, track) and 'hist' (finished heats)
  data       jsonb,
  rev        bigint not null default 0,        -- goes up by one on every save; stops two computers overwriting each other
  updated_at timestamptz not null default now()
);
insert into public.staff_state (id) values ('core'), ('hist') on conflict (id) do nothing;
alter table public.staff_state enable row level security;
drop policy if exists "staff read state" on public.staff_state;
create policy "staff read state" on public.staff_state for select to authenticated using (true);
drop policy if exists "staff write state" on public.staff_state;
create policy "staff write state" on public.staff_state for update to authenticated using (true) with check (true);
do $$ begin
  alter publication supabase_realtime add table public.staff_state;
exception when duplicate_object then null; end $$;

-- 2) Permanent heat archive (same as heat-history.sql; skipped if it already exists).
create table if not exists public.heat_history (
  id   text primary key,
  at   timestamptz not null,
  data jsonb not null
);
create index if not exists heat_history_at on public.heat_history (at desc);
alter table public.heat_history enable row level security;
drop policy if exists "public can read history" on public.heat_history;
create policy "public can read history" on public.heat_history for select to anon, authenticated using (true);
drop policy if exists "staff can add history" on public.heat_history;
create policy "staff can add history" on public.heat_history for insert to authenticated with check (true);

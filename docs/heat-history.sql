-- Dan Karting: permanent heat archive (one row per finished heat).
-- Anyone may read (the public site can show history); only signed-in staff may add. Nobody can edit or delete from the app.
create table if not exists public.heat_history (
  id   text primary key,          -- <heatId>-<finish time ms>
  at   timestamptz not null,      -- when the heat finished
  data jsonb not null             -- the full result (drivers, karts, laps, best, total)
);
create index if not exists heat_history_at on public.heat_history (at desc);
alter table public.heat_history enable row level security;
drop policy if exists "public can read history" on public.heat_history;
create policy "public can read history" on public.heat_history for select to anon, authenticated using (true);
drop policy if exists "staff can add history" on public.heat_history;
create policy "staff can add history" on public.heat_history for insert to authenticated with check (true);

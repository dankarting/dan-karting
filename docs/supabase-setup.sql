-- Dan Karting: public timing board (read-only for everyone, writes only for signed-in staff)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.live_board (
  id         text primary key default 'main',
  data       jsonb not null default '{}'::jsonb,   -- current heat, drivers, laps, timer
  updated_at timestamptz not null default now()
);

insert into public.live_board (id) values ('main') on conflict (id) do nothing;

alter table public.live_board enable row level security;

-- Anyone (the public website) may READ the board.
drop policy if exists "public can read board" on public.live_board;
create policy "public can read board" on public.live_board
  for select to anon, authenticated using (true);

-- Only signed-in staff accounts may WRITE it (the cashier/track app).
drop policy if exists "staff can update board" on public.live_board;
create policy "staff can update board" on public.live_board
  for update to authenticated using (true) with check (true);

-- Push every change to connected phones in real time.
do $$ begin
  alter publication supabase_realtime add table public.live_board;
exception when duplicate_object then null; end $$;

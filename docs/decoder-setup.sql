-- Dan Karting: lap timing from the AMB decoder (run ONCE in Supabase: SQL Editor -> New query -> paste -> Run).
-- The bridge program on the track laptop signs in as a staff user and adds one row per crossing of the
-- timing line. The staff app reads them live and turns them into laps; the public site gets the laps
-- through the normal live board. Only signed-in staff can read or add passings. Nobody edits or deletes from the app.

create table if not exists public.passings (
  uid         text primary key,            -- decoder-decoderTime-transponder (a resend is ignored)
  transponder text   not null,
  t           bigint not null,             -- crossing time, Unix ms (track laptop clock, decoder precision)
  decoder_t   bigint,                      -- the decoder's own clock, ms
  decoder     text,
  hits        int,
  strength    int,
  created_at  timestamptz not null default now()
);
create index if not exists passings_t on public.passings (t desc);
alter table public.passings enable row level security;
drop policy if exists "staff read passings" on public.passings;
create policy "staff read passings" on public.passings for select to authenticated using (true);
drop policy if exists "staff add passings" on public.passings;
create policy "staff add passings" on public.passings for insert to authenticated with check (true);

-- One heartbeat row from the bridge ("is the decoder connected?"), shown in the app's Settings.
create table if not exists public.decoder_status (
  id         text primary key default 'main',
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.decoder_status enable row level security;
drop policy if exists "staff read decoder" on public.decoder_status;
create policy "staff read decoder" on public.decoder_status for select to authenticated using (true);
drop policy if exists "staff add decoder" on public.decoder_status;
create policy "staff add decoder" on public.decoder_status for insert to authenticated with check (true);
drop policy if exists "staff update decoder" on public.decoder_status;
create policy "staff update decoder" on public.decoder_status for update to authenticated using (true) with check (true);

do $$ begin alter publication supabase_realtime add table public.passings;       exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.decoder_status; exception when duplicate_object then null; end $$;

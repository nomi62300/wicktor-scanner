-- The scan moves server-side.
--
-- Until now every browser ran the whole scan itself: ~240 coins of Bybit
-- kline fetches plus scoring, every 5 minutes, per open tab. That caps the
-- universe (more coins = linearly slower for every viewer, and multiplied
-- Bybit rate-limit exposure across tabs) and means two people looking at
-- the scanner can see different results at the same moment.
--
-- The Edge Function already scans the full universe every 5 minutes for the
-- signal journal; it just threw away everything that was not an EXCELLENT
-- signal. Now it stores the whole scored universe here, and browsers read
-- it instead of scanning. One scanner, one truth, and universe size stops
-- being a per-viewer cost.
--
-- APPEND, DON'T UPSERT TWO SLOTS. The client needs the latest snapshot AND
-- the one before it, to tell which coins are newly qualifying and how each
-- score moved. Two fixed 'current'/'previous' rows would need a
-- read-modify-write per cycle and could interleave badly with a concurrent
-- run; appending and reading `order by captured_at desc limit 2` is a
-- single atomic insert with no such window. Old rows are pruned by the
-- writer.
--
-- `scores` IS NOT REDUNDANT WITH `coins`. A client only needs the previous
-- snapshot's per-coin score to compute deltas, not its whole payload.
-- Keeping a small map alongside lets the client fetch the full `coins` of
-- the newest row plus only `scores` of the older one, instead of pulling
-- two full universes over mobile data every poll.

create table if not exists public.scan_snapshot (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  coin_count int not null,
  -- { "BTCUSDT:PERP": 84, ... } — cheap diff source, see note above
  scores jsonb not null,
  -- array of CoinView.build() objects; deliberately excludes tfSnapshots
  coins jsonb not null
);

create index if not exists scan_snapshot_time_idx
  on public.scan_snapshot (captured_at desc);

alter table public.scan_snapshot enable row level security;

-- Readable by anyone, same reasoning as signal_journal and sector_snapshot:
-- this is market observation, not personal data, and the whole point is
-- that every viewer sees the identical computed result. Written only by the
-- scheduled function via service_role.
create policy "scan_snapshot_select_all" on public.scan_snapshot
  for select using (true);

grant select on public.scan_snapshot to anon, authenticated;

-- service_role bypasses RLS POLICIES but not table-level GRANTs, and a
-- table created from raw SQL starts with no base privileges for it. This
-- has now bitten twice in this project (watchlist's first star-toggle, then
-- sector_snapshot's first write, both 42501) — granted up front this time.
-- DELETE is included because the writer prunes its own old rows.
grant select, insert, delete on public.scan_snapshot to service_role;
grant usage, select on sequence public.scan_snapshot_id_seq to service_role;

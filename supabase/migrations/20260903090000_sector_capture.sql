-- Sector rotation capture: the one part of a taught method we could not
-- backtest, recorded going forward so it becomes answerable.
--
-- The question: does a coin being in a strong sector predict better outcomes
-- for our signals? Fixtures hold raw OHLC only, and historical sector-flow
-- snapshots are not retrievable from CoinPaprika after the fact, so this
-- cannot be measured backwards — only accumulated forwards.
--
-- WHY NOT COLUMNS ON signal_journal. Both facts are slow-moving reference
-- data: a coin's sector effectively never changes, and 7d sector performance
-- moves over days, not minutes. Stamping them onto every 5-minute signal row
-- would denormalise slow data across thousands of rows, and — more
-- importantly — would require the live Edge Function (the writer that
-- actually runs 24/7) to fetch CoinPaprika on the critical scan path, adding
-- latency and a failure mode to the thing that must not break. Kept separate
-- and joined at analysis time instead, which also makes the answer
-- RETROACTIVE: rows already in the journal can be attributed to a sector as
-- soon as snapshots exist around their timestamps.
--
-- JOINING TO THE JOURNAL: signal_journal.symbol is a Bybit pair ('HNTUSDT');
-- coin_sector.symbol is the base asset, uppercase ('HNT'). Strip the quote
-- currency when joining. A coin legitimately belongs to several narratives
-- (LOKA is both Gaming and Metaverse), hence the composite key rather than
-- one sector per coin.

create table if not exists public.sector_snapshot (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  sector text not null,
  weighted_change_7d numeric not null,
  weighted_change_24h numeric,
  mcap numeric,
  -- 1 = best performing in this snapshot. sector_count is stored alongside
  -- so a rank stays interpretable if the resolved sector list ever changes
  -- size (two CoinPaprika keywords already fail to resolve, so it can).
  rank smallint not null,
  sector_count smallint not null,
  unique (captured_at, sector)
);

create index if not exists sector_snapshot_time_idx
  on public.sector_snapshot (captured_at desc, rank);

create table if not exists public.coin_sector (
  symbol text not null,          -- base asset, uppercase: 'HNT', not 'HNTUSDT'
  sector text not null,
  market_cap numeric,
  updated_at timestamptz not null default now(),
  primary key (symbol, sector)
);

alter table public.sector_snapshot enable row level security;
alter table public.coin_sector enable row level security;

-- Readable by anyone, same reasoning as signal_journal: this is market
-- observation, not personal data, and the value is that it can be checked.
-- Written only by the scheduled job, which uses service_role (bypasses RLS)
-- — no client-facing insert policy, so nothing in a browser can forge
-- sector history.
create policy "sector_snapshot_select_all" on public.sector_snapshot
  for select using (true);
create policy "coin_sector_select_all" on public.coin_sector
  for select using (true);

grant select on public.sector_snapshot to anon, authenticated;
grant select on public.coin_sector to anon, authenticated;

-- Outcome journal: the forward record of what the v2 model predicted and
-- what actually happened, so the backtest's claims can be checked against
-- live markets rather than trusted.
--
-- WHY THIS TABLE IS NOT USER-SCOPED, unlike watchlist. A signal is a
-- statement about a market ("MONUSDT PERP long at 0.0315, stop 0.0298,
-- target 0.0366 at 09:15"), not personal information. Scoping it per user
-- would fragment the sample across browsers and make the aggregate
-- statistics — the entire reason the table exists — far weaker, while
-- protecting nothing. Every client that sees the same bar logs the same
-- row, and the unique constraint below collapses those into one.
--
-- That unique constraint is doing real work beyond deduplication: it makes
-- writes idempotent and caps abuse. A hostile client cannot inflate the
-- record, because a row for a given (symbol, market, direction, bar_time)
-- can only exist once no matter how many times it is submitted.
--
-- Outcomes are stored for BOTH exit plans, resolved from the same price
-- path, because the plans differ only in how a shared path is harvested:
--   plan_b  straight 3R, single exit
--   plan_a  1/3 out at 1R, stop to breakeven, remainder to 2R and 3R
-- Backtested out-of-sample, plan_a returned +0.0556R net of taker fees
-- against plan_b's +0.0464R with materially lower variance — but a
-- backtest cannot model partial-fill slippage or how a breakeven stop
-- behaves against real wicks, which is what this table is here to settle.

create table if not exists public.signal_journal (
  id bigint generated always as identity primary key,

  -- what the scanner saw
  symbol text not null,
  market text not null check (market in ('SPOT', 'PERP')),
  direction smallint not null check (direction in (1, -1)),
  bar_time bigint not null,              -- entry bar's open time, ms since epoch

  -- the model's own reasoning, kept so outcomes can be attributed
  score smallint not null,
  band text not null,
  context_regime text,
  trigger_name text,
  trigger_bars_ago smallint,
  component_entry smallint,
  component_context smallint,
  component_method smallint,

  -- the trade as specified at signal time; never rewritten afterwards
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  risk_pct numeric not null,             -- 1R as % of entry — drives fee burden

  created_at timestamptz not null default now(),

  -- resolution, filled in by a later scan
  status text not null default 'open' check (status in ('open', 'resolved', 'expired')),
  resolved_at timestamptz,
  resolved_bar_time bigint,
  outcome_a numeric,                     -- realised R, partial + breakeven plan
  outcome_b numeric,                     -- realised R, straight 3R plan
  exit_reason text,                      -- target | stop | breakeven | timeout

  unique (symbol, market, direction, bar_time)
);

create index if not exists signal_journal_open_idx
  on public.signal_journal (status, created_at desc);
create index if not exists signal_journal_symbol_idx
  on public.signal_journal (symbol, market);

alter table public.signal_journal enable row level security;

-- Readable by anyone: the aggregate is the product of the exercise, and
-- there is nothing private in a market observation.
create policy "signal_journal_select_all" on public.signal_journal
  for select using (true);

-- Signed-in clients may log signals and resolve open ones. Deliberately no
-- delete policy and no update of the trade specification: an entry, stop or
-- target that could be edited after the fact would make the whole record
-- worthless as evidence. Resolution can only move a row out of 'open'.
create policy "signal_journal_insert" on public.signal_journal
  for insert to authenticated with check (true);

create policy "signal_journal_resolve" on public.signal_journal
  for update to authenticated
  using (status = 'open')
  with check (status in ('resolved', 'expired'));

-- RLS policies alone do not grant table access — a table created via raw
-- SQL leaves authenticated/anon with no base privileges, which is exactly
-- the 42501 failure the watchlist hit on its first star-toggle.
grant select on public.signal_journal to anon, authenticated;
grant insert, update on public.signal_journal to authenticated;

-- Phase 3: real Supabase Auth + account-scoped watchlist. First real
-- database table for this project — Supabase was previously used only
-- as a CMC-proxy Edge Function, no schema at all.
--
-- Scope deliberately excludes tiering (Phase 4, explicitly deferred to
-- last by the owner): no `tier` column, no gating logic. Clean-slate
-- migration confirmed by the owner — no import path from the existing
-- localStorage watchlist, every account starts empty.

create table if not exists public.watchlist (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  market text not null check (market in ('SPOT', 'PERP')),
  created_at timestamptz not null default now(),
  unique (user_id, symbol, market)
);

create index if not exists watchlist_user_id_idx on public.watchlist (user_id);

alter table public.watchlist enable row level security;

-- Each policy is scoped to auth.uid() = user_id, so a user can only ever
-- see/add/remove their own rows regardless of how the client is coded —
-- the actual security boundary lives here, not in client-side JS.
create policy "watchlist_select_own" on public.watchlist
  for select using (auth.uid() = user_id);

create policy "watchlist_insert_own" on public.watchlist
  for insert with check (auth.uid() = user_id);

create policy "watchlist_delete_own" on public.watchlist
  for delete using (auth.uid() = user_id);

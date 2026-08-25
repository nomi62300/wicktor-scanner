-- Clear signals logged under the superseded fixed-3R geometry.
--
-- Those rows specify a target three times their stop distance, and with 1R
-- ranging from under 1% to over 25% of price that meant anything from a
-- 1.5% move to a 75% one. Measured, the objective was reached on 4.7% of
-- trades: the rows are not a record of a strategy that was ever run, they
-- are a record of a mis-specified one. Resolving them would produce real
-- numbers describing a model that no longer exists, and mixing those into
-- the aggregate is worse than having no aggregate at all.
--
-- Targeted by GEOMETRY, not by timestamp, so a browser still running cached
-- pre-fix JavaScript cannot slip more of them in between now and the moment
-- this runs. round(...) guards against float noise in the ratio.
--
-- This is a deliberate exception to the table's append-mostly design, which
-- is why it lives in a migration rather than behind a standing delete grant:
-- the record of the deletion is itself part of the record. service_role is
-- still not granted DELETE, so nothing outside a reviewed migration can drop
-- a result that simply came out unfavourable.

delete from public.signal_journal
where stop is distinct from entry
  and round((abs(target - entry) / abs(entry - stop))::numeric, 2) = 3.00;

-- Stamp future rows with the model that produced them, so the next geometry
-- change is a filter rather than another manual cleanup. Clients do not set
-- this; the default records it, and changing the model means changing the
-- default in a new migration.
alter table public.signal_journal
  add column if not exists model_version text not null default 'v2.1-pricemove-target';

create index if not exists signal_journal_model_idx
  on public.signal_journal (model_version, status);

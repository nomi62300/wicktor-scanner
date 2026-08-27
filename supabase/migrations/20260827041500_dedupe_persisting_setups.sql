-- Collapse the 4 setups that got logged twice by the bar_time-dedup gap
-- fixed in the same commit as this migration (js/signals.js, tools/
-- cron-scan.js). Each pair is 5 minutes apart, same symbol/market/
-- direction, from one ongoing move re-passing the unique key every closed
-- candle. Keeps the EARLIER row of each pair (the actual trigger moment);
-- drops the later one, which was never a second opportunity.
--
-- Targeted by explicit id, not a general rule, because a general
-- "keep earliest open row per symbol+direction" delete would be too blunt
-- to run unattended -- two GENUINELY separate signals days apart on the
-- same symbol must never collide with this.

delete from public.signal_journal where id in (187, 188, 189, 190);

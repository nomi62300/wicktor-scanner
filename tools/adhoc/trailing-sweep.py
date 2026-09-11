#!/usr/bin/env python3
"""Trailing stop on the runner, instead of a static breakeven.

The idea being tested: book 60% at 0.6R, then instead of parking the
stop at breakeven, TRAIL it so the remaining 40% can keep capturing a
momentum move — potentially far beyond the old 1.2R cap.

This is the first configuration tested here with UNCAPPED upside, which
matters: every previous geometry could only ever win its fixed target,
so nothing could benefit from the rare large move. A trail changes the
shape of the payoff, not just its size.

LOOKAHEAD SAFETY: the trail is advanced using the running high as of
COMPLETED PRIOR bars only, then the stop is checked against the current
bar. Within a single bar it is unknowable whether the new high or the
trail was touched first, so this takes the pessimistic reading — the
trail never benefits from a high it could not yet have seen. Getting
this backwards is the single easiest way to manufacture a fake edge in
a trailing-stop backtest.
"""
import json
import math
import statistics

TAKER = 0.11
FULL_BARS = 145

with open("./r_paths_long.json") as f:
    ALL = json.load(f)
PATHS = [p for p in ALL if len(p["bars"]) >= FULL_BARS]


def run(path, hold_bars, tps, fractions, trail_after=None, trail_dist=None,
        stop_after=None, s=1.0):
    """tps/fractions: the take-profit ladder (may be empty for pure trail).
    trail_after: R level at which trailing begins (None = never).
    trail_dist:  how far behind the running high the stop sits, in R.
    stop_after:  static stop level after each rung (used when not trailing).
    """
    bars = path["bars"][:hold_bars + 1]
    stop_at = -s
    remaining, realised, rung = 1.0, 0.0, 0
    max_fav = 0.0
    trailing = False

    for fav_r, adv_r, close_r in bars:
        # Advance the trail from PRIOR bars' high only.
        if trail_dist is not None and (trailing or (trail_after is not None and max_fav >= trail_after)):
            trailing = True
            stop_at = max(stop_at, max_fav - trail_dist)

        if -adv_r <= stop_at:
            realised += remaining * stop_at
            remaining = 0.0
            break

        while rung < len(tps) and fav_r >= tps[rung]:
            take = min(fractions[rung], remaining)
            realised += take * tps[rung]
            remaining -= take
            if stop_after is not None and stop_after[rung] is not None:
                stop_at = max(stop_at, stop_after[rung])
            rung += 1
            if remaining <= 1e-9:
                break
        if remaining <= 1e-9:
            break

        if fav_r > max_fav:
            max_fav = fav_r

    if remaining > 1e-9:
        realised += remaining * bars[-1][2]
    return realised / s - TAKER / (path["riskPct"] * s)


def baseline(p):
    t = p["origTargetR"]
    return run(p, 48, [t / 3, 2 * t / 3, t], [1/3, 1/3, 1/3], stop_after=[0.0, t / 3, None])


def se_of(xs):
    return statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0


def row(label, fn):
    l, s = [], []
    for p in PATHS:
        (l if p["dir"] == 1 else s).append(fn(p))
    m = (statistics.mean(l) + statistics.mean(s)) / 2
    se = 0.5 * math.sqrt(se_of(l) ** 2 + se_of(s) ** 2)
    lo, hi = m - 1.96 * se, m + 1.96 * se
    star = "*" if (lo > 0 or hi < 0) else " "

    dl = [fn(p) - baseline(p) for p in PATHS if p["dir"] == 1]
    ds = [fn(p) - baseline(p) for p in PATHS if p["dir"] == -1]
    dm = (statistics.mean(dl) + statistics.mean(ds)) / 2
    dse = 0.5 * math.sqrt(se_of(dl) ** 2 + se_of(ds) ** 2)
    dstar = "*" if abs(dm) > 1.96 * dse else " "

    allv = l + s
    big = sum(1 for x in allv if x >= 2.0) / len(allv) * 100
    print(f"  {label:<44} {m:+.4f}{star} CI [{lo:+.4f},{hi:+.4f}]  vs today {dm:+.4f}{dstar}  >=2R: {big:4.1f}%")
    return m


H = 144
print(f"{len(PATHS)} trades, complete 12h window. * = 95% CI excludes zero.")
print("'>=2R' is the share of trades returning 2R or more — only an uncapped")
print("geometry can produce these, and they are the whole point of a trail.\n")

print("=" * 118)
print("REFERENCE POINTS (12h hold)")
print("=" * 118)
row("today's geometry (4h, current targets)", baseline)
row("60/40 @ 0.6/1.2, static breakeven", lambda p: run(p, H, [0.6, 1.2], [0.6, 0.4], stop_after=[0.0, None]))
row("single TP 1.0R, no partials", lambda p: run(p, H, [1.0], [1.0], stop_after=[None]))

print("\n" + "=" * 118)
print("THE PROPOSAL — book 60% at 0.6R, then TRAIL the remaining 40% (NO 1.2R cap)")
print("=" * 118)
for d in [0.2, 0.3, 0.5, 0.75, 1.0]:
    row(f"60% at 0.6R, trail 40% by {d}R",
        lambda p, dd=d: run(p, H, [0.6], [0.6], trail_after=0.6, trail_dist=dd, stop_after=[0.0]))

print("\n" + "=" * 118)
print("SAME, BUT KEEPING THE 1.2R CAP (does the uncapped upside actually pay?)")
print("=" * 118)
for d in [0.3, 0.5]:
    row(f"60% at 0.6R, trail by {d}R, TP2 caps at 1.2R",
        lambda p, dd=d: run(p, H, [0.6, 1.2], [0.6, 0.4], trail_after=0.6, trail_dist=dd, stop_after=[0.0, None]))

print("\n" + "=" * 118)
print("NO PARTIAL AT ALL — trail the WHOLE position (partials have hurt in every test so far)")
print("=" * 118)
for after in [0.5, 0.6, 1.0]:
    for d in [0.3, 0.5, 0.75]:
        row(f"100% trailed by {d}R once {after}R reached",
            lambda p, a=after, dd=d: run(p, H, [], [], trail_after=a, trail_dist=dd))

print("\n" + "=" * 118)
print("BEST TRAIL — directional split, and what the tail actually looks like")
print("=" * 118)
best_fn = lambda p: run(p, H, [], [], trail_after=0.6, trail_dist=0.5)
l = [best_fn(p) for p in PATHS if p["dir"] == 1]
s = [best_fn(p) for p in PATHS if p["dir"] == -1]
allv = l + s
print(f"  100% trailed by 0.5R once 0.6R reached:")
print(f"    longs  n={len(l):<5} {statistics.mean(l):+.4f}R  win {sum(1 for x in l if x>0)/len(l)*100:.1f}%")
print(f"    shorts n={len(s):<5} {statistics.mean(s):+.4f}R  win {sum(1 for x in s if x>0)/len(s)*100:.1f}%")
srt = sorted(allv)
print(f"    best trade {srt[-1]:+.2f}R   p99 {srt[int(len(srt)*0.99)]:+.2f}R   "
      f"p95 {srt[int(len(srt)*0.95)]:+.2f}R   median {srt[len(srt)//2]:+.2f}R")
print(f"    trades >=2R: {sum(1 for x in allv if x>=2)} ({sum(1 for x in allv if x>=2)/len(allv)*100:.1f}%)   "
      f">=3R: {sum(1 for x in allv if x>=3)} ({sum(1 for x in allv if x>=3)/len(allv)*100:.1f}%)")

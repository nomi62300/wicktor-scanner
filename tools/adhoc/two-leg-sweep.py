#!/usr/bin/env python3
"""Tests the owner's two-leg proposal: book 65% at 0.6R, move to
breakeven, let 35% run to 1.2R.

Compared against the alternatives it needs to beat to be worth shipping:
today's geometry, the single-TP benchmark, the three-leg ladder, and
variations of both the split and the levels — so the answer is "is this
the right shape", not just "is this better than nothing".

Run at every hold window, because the hold-window sweep showed the 4h
timeout is what was strangling anything above ~0.5R, and a 1.2R runner
needs time to get there.

Everything direction-balanced. The pooled numbers in this sample are
meaningless: it is ~59% short over a window in which BTC fell 2.72%.
"""
import json
import math
import statistics

TAKER = 0.11
FULL_BARS = 145

with open("./r_paths_long.json") as f:
    ALL = json.load(f)
PATHS = [p for p in ALL if len(p["bars"]) >= FULL_BARS]


def simulate(path, hold_bars, s, tps, fractions, stop_after):
    bars = path["bars"][:hold_bars + 1]
    stop_at = -s
    remaining, realised, rung = 1.0, 0.0, 0
    for fav_r, adv_r, close_r in bars:
        if -adv_r <= stop_at:
            realised += remaining * stop_at
            remaining = 0.0
            break
        while rung < len(tps) and fav_r >= tps[rung]:
            take = min(fractions[rung], remaining)
            realised += take * tps[rung]
            remaining -= take
            if stop_after[rung] is not None:
                stop_at = stop_after[rung]
            rung += 1
            if remaining <= 1e-9:
                break
        if remaining <= 1e-9:
            break
    if remaining > 1e-9:
        realised += remaining * bars[-1][2]
    return realised / s - TAKER / (path["riskPct"] * s)


def baseline(p, hold=48):
    t = p["origTargetR"]
    return simulate(p, hold, 1.0, [t / 3, 2 * t / 3, t], [1/3, 1/3, 1/3], [0.0, t / 3, None])


def se_of(xs):
    return statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0


def balanced(fn):
    l, s = [], []
    for p in PATHS:
        (l if p["dir"] == 1 else s).append(fn(p))
    m = (statistics.mean(l) + statistics.mean(s)) / 2
    se = 0.5 * math.sqrt(se_of(l) ** 2 + se_of(s) ** 2)
    return m, m - 1.96 * se, m + 1.96 * se, l, s


def row(label, fn, ref=None):
    m, lo, hi, l, s = balanced(fn)
    star = "*" if (lo > 0 or hi < 0) else " "
    delta = ""
    if ref is not None:
        dl = [fn(p) - ref(p) for p in PATHS if p["dir"] == 1]
        ds = [fn(p) - ref(p) for p in PATHS if p["dir"] == -1]
        dm = (statistics.mean(dl) + statistics.mean(ds)) / 2
        dse = 0.5 * math.sqrt(se_of(dl) ** 2 + se_of(ds) ** 2)
        dstar = "*" if abs(dm) > 1.96 * dse else " "
        delta = f"   vs today {dm:+.4f}{dstar}"
    print(f"  {label:<42} {m:+.4f}{star} CI [{lo:+.4f},{hi:+.4f}]{delta}")
    return m


PROPOSAL = dict(tps=[0.6, 1.2], fractions=[0.65, 0.35], stop_after=[0.0, None])

print(f"{len(PATHS)} trades with a complete 12h window. * = 95% CI excludes zero.")
nl = sum(1 for p in PATHS if p["dir"] == 1)
print(f"longs {nl} / shorts {len(PATHS)-nl}  (sample is short-heavy; BTC -2.72% over the window)\n")

print("=" * 104)
print("THE PROPOSAL — 65% at 0.6R, breakeven, 35% runs to 1.2R — at each hold window")
print("=" * 104)
for hb, lab in [(48, "4h"), (72, "6h"), (96, "8h"), (144, "12h")]:
    row(f"proposal @ {lab} hold", lambda p, h=hb: simulate(p, h, 1.0, **PROPOSAL),
        ref=lambda p: baseline(p, 48))

print("\n" + "=" * 104)
print("HOW IT COMPARES at 12h hold (the window where everything works best)")
print("=" * 104)
H = 144
ref = lambda p: baseline(p, 48)
row("today's geometry (4h, current targets)", lambda p: baseline(p, 48), ref=ref)
row("PROPOSAL 65/35 @ 0.6/1.2", lambda p: simulate(p, H, 1.0, **PROPOSAL), ref=ref)
row("single TP 1.0R (previous best)", lambda p: simulate(p, H, 1.0, [1.0], [1.0], [None]), ref=ref)
row("3-leg thirds 0.5/1.0/1.2", lambda p: simulate(p, H, 1.0, [0.5, 1.0, 1.2], [1/3, 1/3, 1/3], [0.0, 0.5, None]), ref=ref)

print("\n" + "=" * 104)
print("IS 65/35 THE RIGHT SPLIT? (same 0.6/1.2 levels, 12h, breakeven after TP1)")
print("=" * 104)
for f1 in [0.35, 0.5, 0.65, 0.8, 1.0]:
    lbl = f"{int(f1*100)}% at 0.6R / {int((1-f1)*100)}% at 1.2R" if f1 < 1 else "100% at 0.6R (no runner)"
    row(lbl, lambda p, a=f1: simulate(p, H, 1.0, [0.6, 1.2], [a, 1 - a], [0.0, None]), ref=ref)

print("\n" + "=" * 104)
print("ARE 0.6 / 1.2 THE RIGHT LEVELS? (65/35 split, 12h, breakeven after TP1)")
print("=" * 104)
for t1, t2 in [(0.5, 1.0), (0.6, 1.2), (0.75, 1.5), (0.6, 1.5), (0.8, 1.6), (1.0, 2.0)]:
    row(f"65% at {t1}R / 35% at {t2}R",
        lambda p, a=t1, b=t2: simulate(p, H, 1.0, [a, b], [0.65, 0.35], [0.0, None]), ref=ref)

print("\n" + "=" * 104)
print("DOES THE BREAKEVEN MOVE HELP THE RUNNER? (65/35 @ 0.6/1.2, 12h)")
print("=" * 104)
row("stop -> breakeven after TP1", lambda p: simulate(p, H, 1.0, [0.6, 1.2], [0.65, 0.35], [0.0, None]), ref=ref)
row("stop stays at -1R", lambda p: simulate(p, H, 1.0, [0.6, 1.2], [0.65, 0.35], [None, None]), ref=ref)
row("stop -> +0.3R after TP1 (locks profit)", lambda p: simulate(p, H, 1.0, [0.6, 1.2], [0.65, 0.35], [0.3, None]), ref=ref)

best = simulate
m, lo, hi, l, s = balanced(lambda p: simulate(p, H, 1.0, **PROPOSAL))
print("\n" + "=" * 104)
print("THE PROPOSAL'S DIRECTIONAL SPLIT at 12h — where the result actually comes from")
print("=" * 104)
print(f"  longs  n={len(l):<5} {statistics.mean(l):+.4f}R   win {sum(1 for x in l if x>0)/len(l)*100:.1f}%")
print(f"  shorts n={len(s):<5} {statistics.mean(s):+.4f}R   win {sum(1 for x in s if x>0)/len(s)*100:.1f}%")
print(f"  balanced {m:+.4f}R  CI [{lo:+.4f},{hi:+.4f}]")
mx = 0.65 * 0.6 + 0.35 * 1.2
print(f"\n  Max win if both legs fill: 0.65x0.6 + 0.35x1.2 = {mx:.3f}R   |   a stop-out costs -1.000R")
print(f"  Breakeven win rate needed: {1/(1+mx)*100:.1f}%")

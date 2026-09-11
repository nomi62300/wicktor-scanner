#!/usr/bin/env python3
"""Does the 4h timeout cut the bigger targets short?

The engine times a signal out after 48 bars (4h), a limit set when the
target was 0.16-0.59R. A 1R target on a 2% stop needs a 2% move, so the
larger targets that tested well may be losing to the clock rather than to
the market. This sweeps hold window x target against the same real paths.

FAIRNESS: only trades whose FULL 12h window exists are used. The most
recent trades have not had 12h elapse yet, and including them would give
every long-window arm truncated data while the 4h arm was complete —
which would manufacture exactly the result being tested for. n is printed
so the cost of that restriction is visible.

Everything is direction-balanced and paired against the CURRENT system
(4h hold + today's target geometry), because the sample is short-heavy in
a falling window and the pooled figures are misleading.
"""
import json
import math
import statistics

TAKER = 0.11
THIRDS = [1 / 3, 1 / 3, 1 / 3]
FULL_BARS = 145                     # 144 hold bars + the entry bar

with open("./r_paths_long.json") as f:
    ALL = json.load(f)

PATHS = [p for p in ALL if len(p["bars"]) >= FULL_BARS]
print(f"{len(ALL)} paths extracted; {len(PATHS)} have a complete 12h window and are used.")
nl = sum(1 for p in PATHS if p["dir"] == 1)
print(f"longs {nl} ({nl/len(PATHS)*100:.1f}%)  shorts {len(PATHS)-nl} ({(len(PATHS)-nl)/len(PATHS)*100:.1f}%)\n")


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


def baseline(p):
    """Today's system: 4h hold, targets as fractions of a 1%-of-price move."""
    t = p["origTargetR"]
    return simulate(p, 48, 1.0, [t / 3, 2 * t / 3, t], THIRDS, [0.0, t / 3, None])


def se_of(xs):
    return statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0


def balanced(vals_by_dir):
    l, s = vals_by_dir
    m = (statistics.mean(l) + statistics.mean(s)) / 2
    se = 0.5 * math.sqrt(se_of(l) ** 2 + se_of(s) ** 2)
    return m, m - 1.96 * se, m + 1.96 * se


def split(fn):
    l, s = [], []
    for p in PATHS:
        (l if p["dir"] == 1 else s).append(fn(p))
    return l, s


BASE_L, BASE_S = split(baseline)
b_m, b_lo, b_hi = balanced((BASE_L, BASE_S))
print("=" * 100)
print(f"BASELINE (today: 4h hold, current targets)   balanced {b_m:+.4f}R  CI [{b_lo:+.4f},{b_hi:+.4f}]")
print("=" * 100)

HOLDS = [(48, "4h"), (72, "6h"), (96, "8h"), (144, "12h")]
TARGETS = [0.5, 0.75, 1.0, 1.2, 1.5, 2.0]

print("\nABSOLUTE balanced net R — single TP, stop 1R")
print(f"  {'hold':<6}" + "".join(f"{'TP ' + str(t) + 'R':>12}" for t in TARGETS))
best = None
for hb, label in HOLDS:
    cells = []
    for t in TARGETS:
        l, s = split(lambda p: simulate(p, hb, 1.0, [t], [1.0], [None]))
        m, lo, hi = balanced((l, s))
        star = "*" if (lo > 0 or hi < 0) else " "
        cells.append(f"{m:+11.4f}{star}")
        if best is None or m > best[0]:
            best = (m, lo, hi, label, t, l, s)
    print(f"  {label:<6}" + "".join(cells))

print("\nPAIRED improvement vs today (balanced) — single TP, stop 1R")
print(f"  {'hold':<6}" + "".join(f"{'TP ' + str(t) + 'R':>12}" for t in TARGETS))
for hb, label in HOLDS:
    cells = []
    for t in TARGETS:
        dl = [simulate(p, hb, 1.0, [t], [1.0], [None]) - baseline(p) for p in PATHS if p["dir"] == 1]
        ds = [simulate(p, hb, 1.0, [t], [1.0], [None]) - baseline(p) for p in PATHS if p["dir"] == -1]
        m, lo, hi = balanced((dl, ds))
        star = "*" if (lo > 0 or hi < 0) else " "
        cells.append(f"{m:+11.4f}{star}")
    print(f"  {label:<6}" + "".join(cells))

m, lo, hi, label, t, bl, bs = best
print(f"\nBEST CELL: {label} hold, TP {t}R -> balanced {m:+.4f}R  CI [{lo:+.4f},{hi:+.4f}]")
print(f"  longs  n={len(bl):<5} {statistics.mean(bl):+.4f}R  win {sum(1 for x in bl if x>0)/len(bl)*100:.1f}%")
print(f"  shorts n={len(bs):<5} {statistics.mean(bs):+.4f}R  win {sum(1 for x in bs if x>0)/len(bs)*100:.1f}%")
print(f"  {'POSITIVE — CI excludes zero' if lo > 0 else 'still not distinguishable from / below zero'}")

print("\nDoes the extra time help the LADDER too? (TP 0.5/1.0/1.2, BE after TP1)")
for hb, label in HOLDS:
    l, s = split(lambda p: simulate(p, hb, 1.0, [0.5, 1.0, 1.2], THIRDS, [0.0, 0.5, None]))
    m2, lo2, hi2 = balanced((l, s))
    print(f"  {label:<5} balanced {m2:+.4f}R  CI [{lo2:+.4f},{hi2:+.4f}]")

print("\nHow often does each target get REACHED at all, by hold window?")
print(f"  {'hold':<6}" + "".join(f"{'TP ' + str(t) + 'R':>12}" for t in TARGETS))
for hb, label in HOLDS:
    cells = []
    for t in TARGETS:
        hit = sum(1 for p in PATHS if any(f >= t for f, _, _ in p["bars"][:hb + 1]))
        cells.append(f"{hit/len(PATHS)*100:11.1f}%")
    print(f"  {label:<6}" + "".join(cells))

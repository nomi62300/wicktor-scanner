#!/usr/bin/env python3
"""Paired test: is the bigger-target geometry genuinely better than what
is running today?

Comparing two independent confidence intervals is the wrong test here and
badly underpowered — every trade is simulated under BOTH geometries on
the SAME price path, so the comparison is paired. Testing the per-trade
DIFFERENCE removes all the between-trade variance (which is enormous:
most of the spread is "this symbol moved a lot" and is common to both
arms) and answers the actual question: for the same signal on the same
bar, does changing only the exit improve the result?

Still reported direction-balanced, because the improvement could
otherwise be an artefact of a short-heavy book in a falling market.
"""
import json
import math
import statistics

TAKER = 0.11
THIRDS = [1 / 3, 1 / 3, 1 / 3]

with open("./r_paths.json") as f:
    PATHS = json.load(f)


def simulate(path, s, tps, fractions, stop_after):
    stop_at = -s
    remaining, realised, rung = 1.0, 0.0, 0
    for fav_r, adv_r, close_r in path["bars"]:
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
        realised += remaining * (path["bars"][-1][2] if path["bars"] else 0.0)
    return realised / s - TAKER / (path["riskPct"] * s)


def baseline(p):
    t = p["origTargetR"]
    return simulate(p, 1.0, [t / 3, 2 * t / 3, t], THIRDS, [0.0, t / 3, None])


def mean_ci(xs):
    m = statistics.mean(xs)
    se = statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0
    return m, m - 1.96 * se, m + 1.96 * se, se


def paired(name, fn):
    dl, ds = [], []
    for p in PATHS:
        d = fn(p) - baseline(p)
        (dl if p["dir"] == 1 else ds).append(d)

    m_l, _, _, se_l = mean_ci(dl)
    m_s, _, _, se_s = mean_ci(ds)
    bal = (m_l + m_s) / 2
    se = 0.5 * math.sqrt(se_l ** 2 + se_s ** 2)
    lo, hi = bal - 1.96 * se, bal + 1.96 * se
    z = bal / se if se else 0
    verdict = "IMPROVES" if lo > 0 else ("WORSE" if hi < 0 else "not significant")
    print(f"  {name:<32} delta {bal:+.4f}R  CI [{lo:+.4f},{hi:+.4f}]  z={z:+.1f}  {verdict}")
    return bal


print(f"{len(PATHS)} trades, each simulated under both geometries on its own real path.")
print("Delta is direction-balanced change in net R versus the CURRENT geometry.\n")
print("=" * 96)
print("CHANGE IN NET R vs TODAY (paired, balanced)")
print("=" * 96)

paired("TP 0.5/1.0/1.2 (proposal)", lambda p: simulate(p, 1.0, [0.5, 1.0, 1.2], THIRDS, [0.0, 0.5, None]))
paired("single TP 1.0R", lambda p: simulate(p, 1.0, [1.0], [1.0], [None]))
paired("single TP 0.75R", lambda p: simulate(p, 1.0, [0.75], [1.0], [None]))
paired("single TP 1.2R", lambda p: simulate(p, 1.0, [1.2], [1.0], [None]))
paired("single TP 1.5R", lambda p: simulate(p, 1.0, [1.5], [1.0], [None]))
paired("TP 1.0/1.5/2.0", lambda p: simulate(p, 1.0, [1.0, 1.5, 2.0], THIRDS, [0.0, 1.0, None]))
paired("TP 0.5/1.0/1.5, no BE move", lambda p: simulate(p, 1.0, [0.5, 1.0, 1.5], THIRDS, [None, None, None]))

print("\n" + "=" * 96)
print("BUT: is the RESULT positive, or just less negative? (absolute, balanced)")
print("=" * 96)


def absolute(name, fn):
    l = [fn(p) for p in PATHS if p["dir"] == 1]
    s = [fn(p) for p in PATHS if p["dir"] == -1]
    m_l, _, _, se_l = mean_ci(l)
    m_s, _, _, se_s = mean_ci(s)
    bal = (m_l + m_s) / 2
    se = 0.5 * math.sqrt(se_l ** 2 + se_s ** 2)
    lo, hi = bal - 1.96 * se, bal + 1.96 * se
    verdict = "POSITIVE" if lo > 0 else ("NEGATIVE" if hi < 0 else "indistinguishable from zero")
    print(f"  {name:<32} balanced {bal:+.4f}R  CI [{lo:+.4f},{hi:+.4f}]  {verdict}")


absolute("current geometry", baseline)
absolute("TP 0.5/1.0/1.2 (proposal)", lambda p: simulate(p, 1.0, [0.5, 1.0, 1.2], THIRDS, [0.0, 0.5, None]))
absolute("single TP 1.0R", lambda p: simulate(p, 1.0, [1.0], [1.0], [None]))
absolute("single TP 1.5R", lambda p: simulate(p, 1.0, [1.5], [1.0], [None]))

print("\n" + "=" * 96)
print("THE ELEPHANT — longs vs shorts under the best geometry")
print("=" * 96)
best = lambda p: simulate(p, 1.0, [1.0], [1.0], [None])
l = [best(p) for p in PATHS if p["dir"] == 1]
s = [best(p) for p in PATHS if p["dir"] == -1]
print(f"  longs  n={len(l):<5} {statistics.mean(l):+.4f}R   win {sum(1 for x in l if x>0)/len(l)*100:.1f}%")
print(f"  shorts n={len(s):<5} {statistics.mean(s):+.4f}R   win {sum(1 for x in s if x>0)/len(s)*100:.1f}%")
print(f"  spread {statistics.mean(s) - statistics.mean(l):+.4f}R between the two sides.")

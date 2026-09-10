#!/usr/bin/env python3
"""The pooled mean says the bigger targets fix the edge. The
direction-balanced mean says they do not. This decides which to believe.

Why it matters: the sample is short-heavy (roughly 2:1) over a 4-day
window in which the market fell. A pooled average of a short-heavy book
in a falling market measures the market, not the method — which is why
every measurement in this project is direction-balanced. This prints
longs and shorts separately, with confidence intervals, so the source of
any apparent improvement is visible rather than inferred.
"""
import json
import math
import statistics

from importlib import import_module
sweep = import_module("tp-ladder-sweep".replace("-", "_")) if False else None

TAKER = 0.11
with open("./r_paths.json") as f:
    PATHS = json.load(f)
THIRDS = [1 / 3, 1 / 3, 1 / 3]


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


def ci(xs):
    m = statistics.mean(xs)
    se = statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0
    return m, m - 1.96 * se, m + 1.96 * se


def report(name, fn):
    longs, shorts = [], []
    for p in PATHS:
        (longs if p["dir"] == 1 else shorts).append(fn(p))
    allv = longs + shorts

    m_all, lo_all, hi_all = ci(allv)
    m_l, lo_l, hi_l = ci(longs)
    m_s, lo_s, hi_s = ci(shorts)

    bal = (m_l + m_s) / 2
    se_bal = 0.5 * math.sqrt(
        (statistics.stdev(longs) / math.sqrt(len(longs))) ** 2 +
        (statistics.stdev(shorts) / math.sqrt(len(shorts))) ** 2
    )
    bal_lo, bal_hi = bal - 1.96 * se_bal, bal + 1.96 * se_bal
    star = "*" if (bal_lo > 0 or bal_hi < 0) else " "

    print(f"\n{name}")
    print(f"  pooled    n={len(allv):<5} {m_all:+.4f}  CI [{lo_all:+.4f},{hi_all:+.4f}]")
    print(f"  longs     n={len(longs):<5} {m_l:+.4f}  CI [{lo_l:+.4f},{hi_l:+.4f}]")
    print(f"  shorts    n={len(shorts):<5} {m_s:+.4f}  CI [{lo_s:+.4f},{hi_s:+.4f}]")
    print(f"  BALANCED        {bal:+.4f}{star} CI [{bal_lo:+.4f},{bal_hi:+.4f}]")
    return bal


print(f"{len(PATHS)} trades. * = balanced 95% CI excludes zero.")
print("=" * 72)

report("BASELINE — current geometry (targets = fractions of a 1%-of-price move)",
       lambda p: simulate(p, 1.0, [p["origTargetR"] / 3, 2 * p["origTargetR"] / 3, p["origTargetR"]],
                          THIRDS, [0.0, p["origTargetR"] / 3, None]))

report("PROPOSAL — SL 1R, TPs 0.5 / 1.0 / 1.2R, breakeven after TP1",
       lambda p: simulate(p, 1.0, [0.5, 1.0, 1.2], THIRDS, [0.0, 0.5, None]))

report("BEST POOLED CELL — single TP at 1.0R, stop 1R",
       lambda p: simulate(p, 1.0, [1.0], [1.0], [None]))

print("\n" + "=" * 72)
print("Directional composition of the sample")
print("=" * 72)
nl = sum(1 for p in PATHS if p["dir"] == 1)
ns = len(PATHS) - nl
print(f"  longs {nl} ({nl/len(PATHS)*100:.1f}%)   shorts {ns} ({ns/len(PATHS)*100:.1f}%)")
print("  A short-heavy book in a falling market lifts the pooled mean without")
print("  any change in method quality. That is what the balanced figure removes.")

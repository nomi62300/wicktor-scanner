#!/usr/bin/env python3
"""Broad search of the exit-geometry space, ranked by ROBUSTNESS.

Ranking by full-sample mean would be actively misleading here: the
chronological split showed every geometry flipping sign between the two
halves of this window, so a full-sample winner can easily be a config
that is spectacular in the fast half and ruinous in the quiet one.

So every scenario is scored in BOTH halves and ranked by the WORSE of
the two (a minimax criterion). A config that is merely decent in both
beats one that is brilliant in one and catastrophic in the other — the
latter is a bet on regime, not an edge.

Covers: initial stop width (including WIDER, never tested before),
partial ladders, breakeven and lock-in moves, fixed-distance trails,
proportional give-back trails, ratcheting trails, and combinations.
"""
import json
import math
import statistics

TAKER = 0.11
FULL = 145
HOLD = 144

P = [p for p in json.load(open("./r_paths_long.json")) if len(p["bars"]) >= FULL]
P.sort(key=lambda x: x["bar_time"])
MID = P[len(P) // 2]["bar_time"]
H1 = [p for p in P if p["bar_time"] < MID]
H2 = [p for p in P if p["bar_time"] >= MID]


def sim(path, s=1.0, tps=(), fracs=(), locks=(),
        trail_after=None, trail_dist=None, trail_giveback=None,
        ratchet=None, hold=HOLD):
    """
    s             initial stop, in R0
    tps/fracs     partial ladder levels and sizes
    locks         stop level after each rung (None = unchanged)
    trail_after   R at which trailing starts
    trail_dist    fixed trail distance in R
    trail_giveback  proportional trail: stop = max_fav * (1 - giveback)
    ratchet       list of (above_R, tighter_dist) to tighten the trail as profit grows
    """
    bars = path["bars"][:hold + 1]
    stop = -s
    rem, real, rung = 1.0, 0.0, 0
    mx = 0.0
    trailing = False

    for fav, adv, close in bars:
        if trail_after is not None and (trailing or mx >= trail_after):
            trailing = True
            if trail_giveback is not None:
                cand = mx * (1.0 - trail_giveback)
            else:
                d = trail_dist
                if ratchet:
                    for above, tighter in ratchet:
                        if mx >= above:
                            d = tighter
                cand = mx - d
            if cand > stop:
                stop = cand

        if -adv <= stop:
            real += rem * stop
            rem = 0.0
            break

        while rung < len(tps) and fav >= tps[rung]:
            take = min(fracs[rung], rem)
            real += take * tps[rung]
            rem -= take
            if rung < len(locks) and locks[rung] is not None and locks[rung] > stop:
                stop = locks[rung]
            rung += 1
            if rem <= 1e-9:
                break
        if rem <= 1e-9:
            break

        if fav > mx:
            mx = fav

    if rem > 1e-9:
        real += rem * bars[-1][2]
    return real / s - TAKER / (path["riskPct"] * s)


def bal(sub, fn):
    l = [fn(p) for p in sub if p["dir"] == 1]
    s = [fn(p) for p in sub if p["dir"] == -1]
    m = (statistics.mean(l) + statistics.mean(s)) / 2
    se = 0.5 * math.sqrt((statistics.stdev(l) / math.sqrt(len(l))) ** 2 +
                         (statistics.stdev(s) / math.sqrt(len(s))) ** 2)
    return m, se


def baseline(p):
    t = p["origTargetR"]
    return sim(p, 1.0, (t/3, 2*t/3, t), (1/3, 1/3, 1/3), (0.0, t/3, None), hold=48)


SCEN = []
def add(name, fn): SCEN.append((name, fn))

add("TODAY (4h, current targets)", baseline)

# --- stop width, including WIDER (never tested) ---------------------------
for s in [0.7, 1.0, 1.3, 1.6, 2.0]:
    add(f"stop {s}R0 + trail 0.3R after 1.0R",
        lambda p, ss=s: sim(p, ss, trail_after=1.0*ss, trail_dist=0.3*ss))

# --- fixed trails, activation x distance ----------------------------------
for a in [0.4, 0.6, 0.8, 1.0, 1.5]:
    for d in [0.2, 0.3, 0.5]:
        add(f"trail {d}R after {a}R", lambda p, aa=a, dd=d: sim(p, 1.0, trail_after=aa, trail_dist=dd))

# --- proportional give-back trails ----------------------------------------
for a in [0.5, 0.8, 1.0]:
    for g in [0.2, 0.35, 0.5]:
        add(f"giveback {int(g*100)}% after {a}R",
            lambda p, aa=a, gg=g: sim(p, 1.0, trail_after=aa, trail_giveback=gg))

# --- ratcheting trails (tighten as profit grows) --------------------------
add("trail 0.5R, tighten to 0.25R above 2R",
    lambda p: sim(p, 1.0, trail_after=0.6, trail_dist=0.5, ratchet=[(2.0, 0.25)]))
add("trail 0.5R, tighten to 0.3R>1.5R, 0.2R>3R",
    lambda p: sim(p, 1.0, trail_after=0.6, trail_dist=0.5, ratchet=[(1.5, 0.3), (3.0, 0.2)]))
add("trail 0.3R, tighten to 0.15R above 2R",
    lambda p: sim(p, 1.0, trail_after=1.0, trail_dist=0.3, ratchet=[(2.0, 0.15)]))

# --- partial + trail combinations -----------------------------------------
for f1 in [0.3, 0.5]:
    add(f"{int(f1*100)}% at 0.6R, trail rest 0.3R",
        lambda p, a=f1: sim(p, 1.0, (0.6,), (a,), (0.0,), trail_after=0.6, trail_dist=0.3))
add("50% at 1.0R, trail rest 0.3R", lambda p: sim(p, 1.0, (1.0,), (0.5,), (0.0,), trail_after=1.0, trail_dist=0.3))

# --- breakeven / lock variants, no trail ----------------------------------
add("60/40 @0.6/1.2 static BE", lambda p: sim(p, 1.0, (0.6, 1.2), (0.6, 0.4), (0.0, None)))
add("single TP 1.0R", lambda p: sim(p, 1.0, (1.0,), (1.0,), (None,)))
add("single TP 1.5R", lambda p: sim(p, 1.0, (1.5,), (1.0,), (None,)))
add("no stop move, no TP (hold 12h)", lambda p: sim(p, 1.0))

rows = []
for name, fn in SCEN:
    m_all, se_all = bal(P, fn)
    m1, se1 = bal(H1, fn)
    m2, se2 = bal(H2, fn)
    rows.append((min(m1, m2), name, m_all, se_all, m1, m2))

rows.sort(reverse=True)
print(f"{len(P)} trades, split {len(H1)}/{len(H2)} at the midpoint of the window.")
print("Ranked by the WORSE half — a config must survive both regimes, not average them.\n")
print(f"  {'scenario':<44}{'worse half':>12}{'1st half':>11}{'2nd half':>11}{'full':>11}{'':>4}")
print("  " + "-" * 92)
for worse, name, m_all, se_all, m1, m2 in rows:
    star = "*" if abs(m_all) > 1.96 * se_all else " "
    flip = "FLIP" if m1 * m2 < 0 else "same"
    print(f"  {name:<44}{worse:+12.4f}{m1:+11.4f}{m2:+11.4f}{m_all:+11.4f}{star} {flip}")

print("\n" + "=" * 96)
best_worse = rows[0]
print(f"Most robust by worse-half: {best_worse[1]}  (worse half {best_worse[0]:+.4f})")
n_pos = sum(1 for r in rows if r[0] > 0)
print(f"Scenarios profitable in BOTH halves: {n_pos} of {len(rows)}")
print(f"Scenarios that flip sign between halves: {sum(1 for r in rows if r[4]*r[5] < 0)} of {len(rows)}")

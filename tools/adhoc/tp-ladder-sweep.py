#!/usr/bin/env python3
"""Simulates arbitrary stop/take-profit geometries against the real
recorded price paths in r_paths.json.

THE NORMALISATION MATTERS. Everything is measured in R0 = the ORIGINAL
stop distance of that trade. A config sets:
    s            stop at s x R0            (s = 1.0 is today's stop)
    tps          take-profits at t x R0
and the realised result is divided by s to express it in units of the
risk ACTUALLY taken. That is the honest comparison: halving the stop
halves the money at risk per trade, so for a fixed risk budget you take
twice the size, and the R-multiple is what carries over. Comparing raw
price moves instead would flatter every tighter stop automatically.

Fees likewise: the round-trip taker fee is a % of NOTIONAL, and notional
scales inversely with stop width at fixed dollar risk, so
    fee_in_R = TAKER / (riskPct * s)
A tighter stop genuinely pays proportionally more fee per unit of risk.
Partial exits do not change it: entry is one full-size fill and the exits
sum to one full size, so total traded notional is the same either way.

Intrabar ordering is unknowable from OHLC, so the stop is always checked
BEFORE the targets on the same bar — the pessimistic reading, matching
how js/signals.js realisedR() measures and how the journal is scored.
"""
import json
import statistics
import math

TAKER = 0.11          # % of notional, round trip
HOLD_BARS = 48

with open("./r_paths.json") as f:
    PATHS = json.load(f)


def simulate(path, s, tps, fractions, stop_after, taker=TAKER):
    """One trade under one geometry.

    s          stop distance in R0
    tps        take-profit levels in R0, ascending
    fractions  size closed at each level (must sum to <= 1)
    stop_after stop level (in R0) after each rung fills; None = leave it
    returns (realised_R, reason)
    """
    stop_at = -s
    remaining = 1.0
    realised = 0.0
    rung = 0
    reason = "timeout"

    for fav_r, adv_r, close_r in path["bars"]:
        # Stop first — pessimistic tie-break.
        if -adv_r <= stop_at:
            realised += remaining * stop_at
            remaining = 0.0
            reason = "stop" if stop_at <= -s + 1e-12 else ("breakeven" if stop_at <= 1e-9 else "locked")
            break

        while rung < len(tps) and fav_r >= tps[rung]:
            take = min(fractions[rung], remaining)
            realised += take * tps[rung]
            remaining -= take
            if stop_after[rung] is not None:
                stop_at = stop_after[rung]
            rung += 1
            if remaining <= 1e-9:
                reason = "target"
                break
        if remaining <= 1e-9:
            break
    else:
        close_r = path["bars"][-1][2] if path["bars"] else 0.0
        realised += remaining * close_r
        remaining = 0.0

    if remaining > 1e-9 and reason == "timeout":
        close_r = path["bars"][-1][2] if path["bars"] else 0.0
        realised += remaining * close_r

    gross_R = realised / s                      # in units of risk actually taken
    fee_R = taker / (path["riskPct"] * s)
    return gross_R - fee_R, gross_R, reason


def evaluate(name, s, tps, fractions, stop_after, paths=PATHS):
    nets, grosses, reasons = [], [], {}
    longs, shorts = [], []
    for p in paths:
        net, gross, reason = simulate(p, s, tps, fractions, stop_after)
        nets.append(net)
        grosses.append(gross)
        reasons[reason] = reasons.get(reason, 0) + 1
        (longs if p["dir"] == 1 else shorts).append(net)

    n = len(nets)
    mean_net = statistics.mean(nets)
    sd = statistics.stdev(nets) if n > 1 else 0
    se = sd / math.sqrt(n) if n else 0
    balanced = ((statistics.mean(longs) + statistics.mean(shorts)) / 2
                if longs and shorts else None)
    return {
        "name": name, "n": n,
        "winPct": sum(1 for x in nets if x > 0) / n * 100,
        "gross": statistics.mean(grosses),
        "net": mean_net,
        "ci_lo": mean_net - 1.96 * se, "ci_hi": mean_net + 1.96 * se,
        "balanced": balanced,
        "reasons": reasons,
    }


def show(r):
    ci = f"[{r['ci_lo']:+.4f},{r['ci_hi']:+.4f}]"
    bal = f"{r['balanced']:+.4f}" if r["balanced"] is not None else "  n/a  "
    sig = "*" if (r["ci_lo"] > 0 or r["ci_hi"] < 0) else " "
    print(f"  {r['name']:<34} win {r['winPct']:5.1f}%  gross {r['gross']:+.4f}  "
          f"NET {r['net']:+.4f}{sig} {ci:>20}  bal {bal}")


THIRDS = [1 / 3, 1 / 3, 1 / 3]

print(f"\n{len(PATHS)} real trade paths, full 4h window, stop checked before targets.")
print("NET is after a 0.11% round-trip taker fee. * = 95% CI excludes zero.\n")

# ---------------------------------------------------------------- baseline --
print("=" * 108)
print("BASELINE — what is running today (targets are fractions of a 1%-of-price move)")
print("=" * 108)
base = []
for p in PATHS:
    t = p["origTargetR"]
    net, gross, reason = simulate(p, 1.0, [t / 3, 2 * t / 3, t], THIRDS, [0.0, t / 3, None])
    base.append(net)
print(f"  {'current PLAN_A (targetR ~0.16-0.59)':<34} win "
      f"{sum(1 for x in base if x > 0) / len(base) * 100:5.1f}%  "
      f"NET {statistics.mean(base):+.4f}")
print(f"  median targetR = {statistics.median(p['origTargetR'] for p in PATHS):.3f}")

# ------------------------------------------------------- the owner's idea ---
print("\n" + "=" * 108)
print("THE PROPOSAL — SL at 1R, TPs at 0.5R / 1.0R / 1.2R")
print("=" * 108)
show(evaluate("TP 0.5/1.0/1.2, BE after TP1", 1.0, [0.5, 1.0, 1.2], THIRDS, [0.0, 0.5, None]))
show(evaluate("TP 0.5/1.0/1.2, no stop move", 1.0, [0.5, 1.0, 1.2], THIRDS, [None, None, None]))

# ------------------------------------------------------------ single TP -----
print("\n" + "=" * 108)
print("SINGLE TARGET, all size at one level, stop 1R (isolates target choice)")
print("=" * 108)
for t in [0.3, 0.5, 0.75, 1.0, 1.2, 1.5, 2.0, 3.0]:
    show(evaluate(f"single TP @ {t}R", 1.0, [t], [1.0], [None]))

# --------------------------------------------------------- 3-leg ladders ----
print("\n" + "=" * 108)
print("THREE-LEG LADDERS, stop 1R, breakeven after TP1 (today's management style)")
print("=" * 108)
for tps in [[0.3, 0.6, 1.0], [0.5, 1.0, 1.2], [0.5, 1.0, 1.5], [0.5, 1.0, 2.0],
            [0.75, 1.25, 2.0], [1.0, 1.5, 2.0], [1.0, 2.0, 3.0]]:
    label = "/".join(str(x) for x in tps)
    show(evaluate(f"TP {label}, BE after TP1", 1.0, tps, THIRDS, [0.0, tps[0], None]))

# ------------------------------------------ does the breakeven move help? ---
print("\n" + "=" * 108)
print("SAME LADDERS WITHOUT THE BREAKEVEN MOVE (does moving the stop up help or hurt?)")
print("=" * 108)
for tps in [[0.3, 0.6, 1.0], [0.5, 1.0, 1.2], [0.5, 1.0, 1.5], [1.0, 1.5, 2.0]]:
    label = "/".join(str(x) for x in tps)
    show(evaluate(f"TP {label}, stop stays -1R", 1.0, tps, THIRDS, [None, None, None]))

# ------------------------------------------------- joint stop x target ------
print("\n" + "=" * 108)
print("JOINT SWEEP — stop width x single target, both in units of TODAY's stop (R0)")
print("(realised R is divided by the stop taken, so these are directly comparable)")
print("=" * 108)
print(f"  {'':<12}" + "".join(f"{'TP ' + str(t) + 'R0':>13}" for t in [0.3, 0.5, 0.75, 1.0, 1.5, 2.0]))
best = None
for s in [1.0, 0.85, 0.7, 0.55, 0.4]:
    cells = []
    for t in [0.3, 0.5, 0.75, 1.0, 1.5, 2.0]:
        r = evaluate("", s, [t], [1.0], [None])
        cells.append(f"{r['net']:+13.4f}")
        if best is None or r["net"] > best[0]:
            best = (r["net"], s, t, r)
    print(f"  stop {s:<7.2f}" + "".join(cells))

print(f"\n  best cell: stop {best[1]}R0, TP {best[2]}R0 -> NET {best[0]:+.4f}R "
      f"(win {best[3]['winPct']:.1f}%, 95% CI [{best[3]['ci_lo']:+.4f},{best[3]['ci_hi']:+.4f}])")

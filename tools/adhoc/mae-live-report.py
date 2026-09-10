#!/usr/bin/env python3
"""Three-way breakdown the owner asked for, from the real per-trade MAE
walk: straight-up winners (never dipped) vs. dipped-then-X trades, split
by final outcome (stop vs target vs timeout)."""
import json
import statistics

with open("./mae_results.json") as f:
    results = json.load(f)

n = len(results)
print(f"Total trades walked: {n}\n")

# maeR == 0 means the trade never traded against the position at all
# (first tick after entry was already favorable or flat).
straight = [r for r in results if r["maeR"] <= 1e-9]
dipped = [r for r in results if r["maeR"] > 1e-9]

print(f"Went straight in our favor (MAE = 0, never dipped): {len(straight)}  ({len(straight)/n*100:.1f}%)")
print(f"Dipped against us at some point (MAE > 0):          {len(dipped)}  ({len(dipped)/n*100:.1f}%)")

print("\n--- Of the trades that dipped, final outcome ---")
for reason in ["stop", "target", "timeout"]:
    sub = [r for r in dipped if r["reason"] == reason]
    print(f"  {reason:8s}: {len(sub):5d}  ({len(sub)/len(dipped)*100:.1f}% of dippers, {len(sub)/n*100:.1f}% of all)")

print("\n--- Of the straight-up trades, final outcome (sanity check -- should be almost all target/timeout, ~0 stop) ---")
for reason in ["stop", "target", "timeout"]:
    sub = [r for r in straight if r["reason"] == reason]
    print(f"  {reason:8s}: {len(sub):5d}  ({len(sub)/len(straight)*100:.1f}% of straight-up)")

print("\n--- How far did the DIPPED trades actually go against us, in R (relative to the recorded stop distance)? ---")
mae_vals = sorted(r["maeR"] for r in dipped)
def pct(p):
    return mae_vals[int(len(mae_vals) * p)]
print(f"  mean={statistics.mean(mae_vals):.3f}R  median={pct(0.5):.3f}R")
print(f"  p25={pct(0.25):.3f}R  p50={pct(0.5):.3f}R  p75={pct(0.75):.3f}R  p90={pct(0.9):.3f}R  p95={pct(0.95):.3f}R  max={mae_vals[-1]:.3f}R")
print("  (1.0R = the full, current stop distance -- a value under 1.0 means it dipped but never touched the stop)")

print("\n--- Same MAE breakdown, but ONLY for trades that eventually hit TARGET (the winners) ---")
winners_dipped = [r for r in dipped if r["reason"] == "target"]
if winners_dipped:
    wv = sorted(r["maeR"] for r in winners_dipped)
    def wpct(p): return wv[int(len(wv) * p)]
    print(f"  n={len(winners_dipped)}  mean={statistics.mean(wv):.3f}R")
    print(f"  p50={wpct(0.5):.3f}R  p75={wpct(0.75):.3f}R  p90={wpct(0.9):.3f}R  p95={wpct(0.95):.3f}R  max={wv[-1]:.3f}R")
    print("  Reading this: if p90 here is well under 1.0R, most eventual WINNERS never got")
    print("  close to the current stop even when they did dip -- real slack to tighten.")

print("\n--- Stop-tightening sweep (net of 0.11% round-trip taker fee), on the REAL trade set ---")
print(f"  {'fraction':10s} {'n stopped early':>16s} {'win%':>7s} {'gross R':>9s} {'NET R':>9s}")
FRACTIONS = ["1.0", "0.85", "0.7", "0.55", "0.4", "0.3", "0.2"]
for f in FRACTIONS:
    sub = [r["byFraction"][f] for r in results]
    stopped_early = sum(1 for i, r in enumerate(results) if r["byFraction"][f]["reason"] == "stop" and r["reason"] != "stop")
    win_pct = sum(1 for s in sub if s["r"] > 0) / len(sub) * 100
    gross = statistics.mean(s["r"] for s in sub)
    net = statistics.mean(s["net"] for s in sub)
    print(f"  {f+'x':10s} {stopped_early:16d} {win_pct:6.1f}% {gross:+9.4f} {net:+9.4f}")

print("\n" + "="*70)
print("ISOLATING: does tightening actually hurt TRUE winners, or is the")
print("degradation above coming from the timeout bucket (54% of dippers)?")
print("="*70)
clean = [r for r in results if r["reason"] in ("stop", "target")]
n_timeouts = len(results) - len(clean)
print(f"\nClean trades only (excl. {n_timeouts} timeouts): n={len(clean)}")
print(f"  {'fraction':10s} {'n winners lost':>15s} {'win%':>7s} {'gross R':>9s} {'NET R':>9s}")
for f in FRACTIONS:
    sub = [r["byFraction"][f] for r in clean]
    winners_lost = sum(1 for r in clean if r["reason"] == "target" and r["byFraction"][f]["reason"] == "stop")
    win_pct = sum(1 for s in sub if s["r"] > 0) / len(sub) * 100
    gross = statistics.mean(s["r"] for s in sub)
    net = statistics.mean(s["net"] for s in sub)
    print(f"  {f+'x':10s} {winners_lost:15d} {win_pct:6.1f}% {gross:+9.4f} {net:+9.4f}")

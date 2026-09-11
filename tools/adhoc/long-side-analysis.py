#!/usr/bin/env python3
"""Why does the long side lose in every period, including rising ones?

Longs were negative in 6 of 6 time slices with a win rate never above
49.6%, while shorts tracked the market. Critically longs lost even in the
slice where BTC ROSE, which rules out "it is just the downtrend" and
points at signal quality.

This asks three questions in order:
  1. COMPOSITION — do longs and shorts get different signals? (score,
     trigger, regime, component scores, stop width)
  2. SUBGROUPS — is ANY cut of longs profitable, or is the whole side bad?
  3. MECHANICS — do long trades simply travel less far in their favour?

Uses outcome_a, the system's own recorded result, so this measures what
actually happened rather than a re-simulation.
"""
import json
import math
import statistics
from collections import defaultdict

rows = [r for r in json.load(open("./v22_rows.json")) if r.get("outcome_a") is not None]
L = [r for r in rows if r["direction"] == 1]
S = [r for r in rows if r["direction"] == -1]


def ci(v):
    if len(v) < 2:
        return (statistics.mean(v) if v else 0), 0, 0
    m = statistics.mean(v)
    se = statistics.stdev(v) / math.sqrt(len(v))
    return m, m - 1.96 * se, m + 1.96 * se


def line(label, v, indent="  "):
    if not v:
        print(f"{indent}{label:<30} n=0")
        return
    m, lo, hi = ci(v)
    star = "*" if (lo > 0 or hi < 0) else " "
    win = sum(1 for x in v if x > 0) / len(v) * 100
    print(f"{indent}{label:<30} n={len(v):<5} {m:+.4f}{star} CI[{lo:+.4f},{hi:+.4f}]  win {win:5.1f}%")


R = lambda rs: [r["outcome_a"] for r in rs]

print(f"{len(rows)} resolved trades   longs {len(L)} ({len(L)/len(rows)*100:.1f}%)   shorts {len(S)}\n")
print("=" * 92)
print("HEADLINE")
print("=" * 92)
line("LONGS", R(L))
line("SHORTS", R(S))

print("\n" + "=" * 92)
print("1. COMPOSITION — are longs given different signals than shorts?")
print("=" * 92)
for field in ["score", "risk_pct", "component_entry", "component_context", "component_method", "trigger_bars_ago"]:
    lv = [r[field] for r in L if r.get(field) is not None]
    sv = [r[field] for r in S if r.get(field) is not None]
    if not lv or not sv:
        continue
    print(f"  {field:<20} longs mean {statistics.mean(lv):8.3f}   shorts mean {statistics.mean(sv):8.3f}"
          f"   diff {statistics.mean(lv)-statistics.mean(sv):+8.3f}")

print("\n  trigger mix:")
lt = defaultdict(int); st = defaultdict(int)
for r in L: lt[r.get("trigger_name") or "none"] += 1
for r in S: st[r.get("trigger_name") or "none"] += 1
for k in sorted(set(lt) | set(st), key=lambda x: -(lt[x] + st[x]))[:8]:
    print(f"    {k:<26} longs {lt[k]/len(L)*100:5.1f}%   shorts {st[k]/len(S)*100:5.1f}%")

print("\n  context regime mix:")
lr = defaultdict(int); sr = defaultdict(int)
for r in L: lr[r.get("context_regime") or "none"] += 1
for r in S: sr[r.get("context_regime") or "none"] += 1
for k in sorted(set(lr) | set(sr), key=lambda x: -(lr[x] + sr[x]))[:8]:
    print(f"    {k:<26} longs {lr[k]/len(L)*100:5.1f}%   shorts {sr[k]/len(S)*100:5.1f}%")

print("\n" + "=" * 92)
print("2. SUBGROUPS — is ANY cut of the long side profitable?")
print("=" * 92)

print("\n  by score band:")
for lo_s, hi_s in [(80, 82), (83, 85), (86, 88), (89, 101)]:
    line(f"score {lo_s}-{hi_s}", R([r for r in L if lo_s <= r["score"] <= hi_s]))

print("\n  by stop width (risk % of price):")
for lo_r, hi_r in [(0, 2), (2, 3), (3, 5), (5, 100)]:
    line(f"riskPct {lo_r}-{hi_r}%", R([r for r in L if r.get("risk_pct") is not None and lo_r <= r["risk_pct"] < hi_r]))

print("\n  by trigger:")
for k in sorted(lt, key=lambda x: -lt[x])[:6]:
    line(k, R([r for r in L if (r.get("trigger_name") or "none") == k]))

print("\n  by context regime:")
for k in sorted(lr, key=lambda x: -lr[x])[:6]:
    line(k, R([r for r in L if (r.get("context_regime") or "none") == k]))

print("\n  by market:")
for k in ["PERP", "SPOT"]:
    line(k, R([r for r in L if r["market"] == k]))

print("\n  by component_method (the Alligator/AO vs suggestive split):")
for lo_m, hi_m in [(0, 40), (40, 60), (60, 80), (80, 101)]:
    line(f"method {lo_m}-{hi_m}", R([r for r in L if r.get("component_method") is not None and lo_m <= r["component_method"] < hi_m]))

print("\n" + "=" * 92)
print("3. MECHANICS — do longs simply travel less far in their favour?")
print("=" * 92)
paths = json.load(open("./r_paths_long.json"))
pl = [p for p in paths if p["dir"] == 1]
ps = [p for p in paths if p["dir"] == -1]


def excursions(sub, bars=48):
    mfe, mae = [], []
    for p in sub:
        w = p["bars"][:bars + 1]
        if not w:
            continue
        mfe.append(max(b[0] for b in w))
        mae.append(max(b[1] for b in w))
    return mfe, mae


for label, sub in [("LONGS", pl), ("SHORTS", ps)]:
    mfe, mae = excursions(sub)
    mfe.sort(); mae.sort()
    q = lambda a, f: a[int(len(a) * f)]
    print(f"  {label:<8} n={len(mfe)}")
    print(f"      MFE (how far it went our way)   median {q(mfe,.5):.3f}R  p75 {q(mfe,.75):.3f}R  p90 {q(mfe,.9):.3f}R")
    print(f"      MAE (how far it went against)   median {q(mae,.5):.3f}R  p75 {q(mae,.75):.3f}R  p90 {q(mae,.9):.3f}R")
    reach = lambda t: sum(1 for x in mfe if x >= t) / len(mfe) * 100
    print(f"      reached 0.5R {reach(0.5):5.1f}%   1.0R {reach(1.0):5.1f}%   1.5R {reach(1.5):5.1f}%")

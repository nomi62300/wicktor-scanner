#!/usr/bin/env python3
"""THE TEST.

In the falling sample (BTC -2.7%), longs reached the SAME favourable
excursion as shorts but suffered ~2x the adverse excursion. Two
explanations were indistinguishable from that sample alone:

  (a) STRUCTURAL — crypto grinds up and drops fast, so LONG entries
      inherently absorb deeper drawdowns before working. If so, longs
      keep the worse MAE even in a rising market.
  (b) BETA — it simply fell for those four days. If so, the asymmetry
      INVERTS in a rising market and SHORTS take the deeper drawdowns.

The replay covers 17-21 Aug 2026, when BTC rose 23.9% — about as clean
an opposite regime as exists.

Framing matters: in each sample one side is WITH the trend and the other
is AGAINST it. Beta predicts the penalty follows the counter-trend side.
Structure predicts it stays on longs regardless.
"""
import json
import statistics

HOLD = 144


def load(path, key_dir="dir"):
    return json.load(open(path))


def excursions(sub, bars=48):
    mfe, mae = [], []
    for p in sub:
        w = p["bars"][:bars + 1]
        if len(w) < 2:
            continue
        mfe.append(max(b[0] for b in w))
        mae.append(max(b[1] for b in w))
    return sorted(mfe), sorted(mae)


def med(a):
    return a[len(a) // 2] if a else float("nan")


def report(name, paths, trend_side):
    L = [p for p in paths if p["dir"] == 1]
    S = [p for p in paths if p["dir"] == -1]
    print(f"\n{'='*86}\n{name}\n{'='*86}")
    print(f"  signals: {len(paths)}   longs {len(L)} ({len(L)/len(paths)*100:.1f}%)   shorts {len(S)} ({len(S)/len(paths)*100:.1f}%)")
    print(f"  trend side = {trend_side}\n")
    out = {}
    print(f"  {'':<9}{'n':>6}{'MFE med':>10}{'MAE med':>10}{'MFE p75':>10}{'MAE p75':>10}{'reach 1R':>10}")
    for lab, sub in [("LONGS", L), ("SHORTS", S)]:
        if not sub:
            print(f"  {lab:<9}{0:>6}")
            out[lab] = None
            continue
        mfe, mae = excursions(sub)
        q = lambda a, f: a[int(len(a) * f)] if a else float("nan")
        reach = sum(1 for x in mfe if x >= 1.0) / len(mfe) * 100
        print(f"  {lab:<9}{len(sub):>6}{med(mfe):>10.3f}{med(mae):>10.3f}{q(mfe,.75):>10.3f}{q(mae,.75):>10.3f}{reach:>9.1f}%")
        out[lab] = {"mfe": med(mfe), "mae": med(mae), "n": len(sub)}
    return out


down = load("./r_paths_long.json")
up = load("./uptrend_signals.json")

d = report("FALLING SAMPLE — 7-11 Sep 2026, BTC -2.7%", down, "SHORTS")
u = report("RISING SAMPLE — 17-21 Aug 2026, BTC +23.9% (engine replay)", up, "LONGS")

print(f"\n{'='*86}\nVERDICT\n{'='*86}")


def ratio(x):
    if not x or not x.get("LONGS") or not x.get("SHORTS"):
        return None
    return x["LONGS"]["mae"] / x["SHORTS"]["mae"]


rd, ru = ratio(d), ratio(u)
print(f"  long/short MAE ratio — falling sample : {rd:.2f}x" if rd else "  falling: n/a")
print(f"  long/short MAE ratio — rising sample  : {ru:.2f}x" if ru else "  rising: n/a")

if rd and ru:
    print()
    if ru > 1.3:
        print("  -> LONGS KEEP THE WORSE ADVERSE EXCURSION EVEN IN A RISING MARKET.")
        print("     Supports (a) STRUCTURAL: crypto long entries inherently absorb")
        print("     deeper drawdowns. Asymmetric stop sizing is the mechanism-matched")
        print("     response, and it should generalise beyond this regime.")
    elif ru < 0.77:
        print("  -> THE ASYMMETRY INVERTS: shorts now take the deeper drawdowns.")
        print("     Supports (b) BETA. The long-side 'failure' was the falling market,")
        print("     not a defect in long signals. Do NOT hard-code any long-side")
        print("     penalty — it would be fitted to one regime.")
    else:
        print("  -> Roughly symmetric in the rising sample: neither explanation is")
        print("     clearly supported. Treat the long-side result as regime-dependent")
        print("     and keep collecting.")

# Which side does the counter-trend penalty actually attach to?
print()
if d.get("LONGS") and u.get("SHORTS"):
    print(f"  counter-trend side MAE  — falling (longs)  : {d['LONGS']['mae']:.3f}R")
    print(f"  counter-trend side MAE  — rising  (shorts) : {u['SHORTS']['mae']:.3f}R")
    print(f"  with-trend side MAE     — falling (shorts) : {d['SHORTS']['mae']:.3f}R")
    print(f"  with-trend side MAE     — rising  (longs)  : {u['LONGS']['mae']:.3f}R")
    print("\n  If the penalty tracks the COUNTER-TREND side in both samples, it is beta.")
    print("  If it tracks LONGS in both samples, it is structural.")

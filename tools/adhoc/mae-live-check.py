#!/usr/bin/env python3
"""Real MAE/MFE analysis on actual logged v2.2-near-target trades (not a
fixture replay) -- pulls real Bybit M5 candles for each trade's actual
entry-to-resolution window and walks them the same way tools/analyze-mae.js
does, to see whether winning trades' stops have real slack to tighten."""
import json
import time
import urllib.request
import urllib.error
from collections import defaultdict

BYBIT = "https://api.bybit.com"
TAKER = 0.11  # % of notional, round trip (matches tools/analyze-mae.js)
FRACTIONS = [1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2]

with open("./v22_rows.json") as f:
    rows = json.load(f)

# Only rows with a real risk distance and a resolved_bar_time
rows = [r for r in rows if r.get("resolved_bar_time") and r.get("entry") and r.get("stop")]
print(f"{len(rows)} usable rows")

by_symbol = defaultdict(list)
for r in rows:
    by_symbol[(r["symbol"], r["market"])].append(r)
print(f"{len(by_symbol)} distinct symbol/market pairs")


def fetch_klines(symbol, category, start_ms, end_ms):
    url = (f"{BYBIT}/v5/market/kline?category={category}&symbol={symbol}"
           f"&interval=5&start={start_ms}&end={end_ms}&limit=1000")
    req = urllib.request.Request(url, headers={"User-Agent": "wicktor-mae-check"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read())
    except Exception as e:
        return None
    if not j or j.get("retCode") != 0 or not j.get("result", {}).get("list"):
        return None
    return sorted([[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5])]
                   for x in j["result"]["list"]], key=lambda x: x[0])


def walk(bars, direction, entry, risk, target_dist, fraction):
    new_risk = risk * fraction
    stop_px = entry - direction * new_risk
    target_px = entry + direction * target_dist
    worst_r, best_r, reason, exit_r = 0.0, 0.0, "timeout", None
    for (t, o, h, l, c, v) in bars:
        adv_px = l if direction == 1 else h
        fav_px = h if direction == 1 else l
        adv_r = (direction * (adv_px - entry)) / risk
        fav_r = (direction * (fav_px - entry)) / risk
        if adv_r < worst_r: worst_r = adv_r
        if fav_r > best_r: best_r = fav_r
        stop_hit = (l <= stop_px) if direction == 1 else (h >= stop_px)
        if stop_hit:
            reason, exit_r = "stop", -1.0
            break
        target_hit = (h >= target_px) if direction == 1 else (l <= target_px)
        if target_hit:
            reason, exit_r = "target", target_dist / new_risk
            break
    if exit_r is None:
        last_c = bars[-1][4]
        exit_r = (direction * (last_c - entry)) / new_risk
    risk_pct_new = new_risk / entry * 100
    return {"maeR": -worst_r, "mfeR": best_r, "reason": reason, "r": exit_r,
            "net": exit_r - TAKER / risk_pct_new}


results = []
symbol_list = sorted(by_symbol.keys())
n_ok, n_fail = 0, 0
for i, (symbol, market) in enumerate(symbol_list):
    trades = by_symbol[(symbol, market)]
    lo = min(t["bar_time"] for t in trades) - 300000
    hi = max(t["resolved_bar_time"] for t in trades) + 300000
    category = "linear" if market == "PERP" else "spot"
    bars = fetch_klines(symbol, category, lo, hi)
    if not bars:
        n_fail += 1
        continue
    n_ok += 1
    for t in trades:
        window = [b for b in bars if t["bar_time"] <= b[0] <= t["resolved_bar_time"]]
        if len(window) < 1:
            continue
        direction = t["direction"]
        entry = float(t["entry"])
        risk = abs(entry - float(t["stop"]))
        if risk <= 0:
            continue
        target_dist = abs(float(t["target"]) - entry)
        by_fraction = {f: walk(window, direction, entry, risk, target_dist, f) for f in FRACTIONS}
        base = by_fraction[1.0]
        results.append({
            "symbol": symbol, "market": market, "dir": direction,
            "outcome_a": t.get("outcome_a"), "recorded_exit": t.get("exit_reason"),
            "maeR": base["maeR"], "mfeR": base["mfeR"], "reason": base["reason"], "r": base["r"],
            "byFraction": {str(k): v for k, v in by_fraction.items()},
        })
    if i % 50 == 0:
        print(f"  {i}/{len(symbol_list)} symbols processed, ok={n_ok} fail={n_fail}, {len(results)} trades walked", flush=True)

print(f"\nDone. {n_ok} symbols fetched ok, {n_fail} failed. {len(results)} trades walked.")
with open("./mae_results.json", "w") as f:
    json.dump(results, f)

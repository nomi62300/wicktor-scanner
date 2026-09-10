#!/usr/bin/env python3
"""Time-based exit test: instead of tightening the STOP distance, test
cutting trades off at a fixed elapsed time if neither the original stop
nor target has been hit yet. Re-fetches the same real Bybit candles (fast,
proven in the prior run) and walks each trade against several time
cutoffs, applied to ALL trades uniformly (a real rule can't know in
advance which ones are "timeout-shaped")."""
import json
import urllib.request
from collections import defaultdict

BYBIT = "https://api.bybit.com"
TAKER = 0.11
CUTOFFS_MIN = [240, 180, 150, 120, 90, 60, 30]  # 240 = current (no early cutoff)

with open("./v22_rows.json") as f:
    rows = json.load(f)
rows = [r for r in rows if r.get("resolved_bar_time") and r.get("entry") and r.get("stop")]

by_symbol = defaultdict(list)
for r in rows:
    by_symbol[(r["symbol"], r["market"])].append(r)


def fetch_klines(symbol, category, start_ms, end_ms):
    url = (f"{BYBIT}/v5/market/kline?category={category}&symbol={symbol}"
           f"&interval=5&start={start_ms}&end={end_ms}&limit=1000")
    req = urllib.request.Request(url, headers={"User-Agent": "wicktor-time-exit-check"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read())
    except Exception:
        return None
    if not j or j.get("retCode") != 0 or not j.get("result", {}).get("list"):
        return None
    return sorted([[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5])]
                   for x in j["result"]["list"]], key=lambda x: x[0])


def walk_time(bars, entry_time, direction, entry, risk, target_dist, cutoff_min):
    stop_px = entry - direction * risk
    target_px = entry + direction * target_dist
    cutoff_ts = entry_time + cutoff_min * 60000
    last_c = entry
    for (t, o, h, l, c, v) in bars:
        if t > cutoff_ts:
            break
        last_c = c
        stop_hit = (l <= stop_px) if direction == 1 else (h >= stop_px)
        if stop_hit:
            return {"reason": "stop", "r": -1.0}
        target_hit = (h >= target_px) if direction == 1 else (l <= target_px)
        if target_hit:
            return {"reason": "target", "r": target_dist / risk}
    exit_r = (direction * (last_c - entry)) / risk
    return {"reason": "time_exit" if cutoff_min < 240 else "timeout", "r": exit_r}


results = []
symbol_list = sorted(by_symbol.keys())
n_ok, n_fail = 0, 0
for i, (symbol, market) in enumerate(symbol_list):
    trades = by_symbol[(symbol, market)]
    lo = min(t["bar_time"] for t in trades) - 300000
    hi = max(t["bar_time"] for t in trades) + 240 * 60000 + 300000  # full 240min window past entry
    category = "linear" if market == "PERP" else "spot"
    bars = fetch_klines(symbol, category, lo, hi)
    if not bars:
        n_fail += 1
        continue
    n_ok += 1
    for t in trades:
        entry_time = t["bar_time"]
        window = [b for b in bars if b[0] >= entry_time]
        if not window:
            continue
        direction = t["direction"]
        entry = float(t["entry"])
        risk = abs(entry - float(t["stop"]))
        if risk <= 0:
            continue
        target_dist = abs(float(t["target"]) - entry)
        by_cutoff = {}
        for cm in CUTOFFS_MIN:
            res = walk_time(window, entry_time, direction, entry, risk, target_dist, cm)
            risk_pct = risk / entry * 100
            res["net"] = res["r"] - TAKER / risk_pct
            by_cutoff[cm] = res
        results.append({"symbol": symbol, "market": market, "byCutoff": by_cutoff})
    if i % 100 == 0:
        print(f"  {i}/{len(symbol_list)} symbols, ok={n_ok} fail={n_fail}, {len(results)} trades", flush=True)

print(f"\nDone. {n_ok} ok, {n_fail} failed. {len(results)} trades.")
with open("./time_exit_results.json", "w") as f:
    json.dump(results, f)

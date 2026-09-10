#!/usr/bin/env python3
"""Extracts each trade's bar-by-bar price path expressed in R, over the
FULL 48-bar (4h) hold window from entry.

Why a fresh walk rather than reusing mae_results.json: that walk stopped
the moment the ORIGINAL target was hit, and the original target is only
0.16-0.59R. It therefore cannot say whether price would have continued
to 1R or 1.2R, which is exactly the question being asked. This one never
exits early -- it records the whole window, so ANY take-profit ladder can
be simulated against it afterwards without refetching a single candle.

Output: r_paths.json, one entry per trade:
    { symbol, market, dir, riskPct, bars: [[favR, advR], ...] }
where favR is how far price went IN OUR FAVOUR by that bar's extreme and
advR how far AGAINST us, both in multiples of the trade's own stop
distance (1R = the current stop).
"""
import json
import urllib.request
from collections import defaultdict

BYBIT = "https://api.bybit.com"
HOLD_BARS = 48                      # 48 x 5M = 4h, the engine's own timeout
BAR_MS = 5 * 60 * 1000

with open("./v22_rows.json") as f:
    rows = json.load(f)
rows = [r for r in rows if r.get("entry") and r.get("stop") and r.get("target")]
print(f"{len(rows)} usable rows")

by_symbol = defaultdict(list)
for r in rows:
    by_symbol[(r["symbol"], r["market"])].append(r)
print(f"{len(by_symbol)} distinct symbol/market pairs")


def fetch_klines(symbol, category, start_ms, end_ms):
    url = (f"{BYBIT}/v5/market/kline?category={category}&symbol={symbol}"
           f"&interval=5&start={start_ms}&end={end_ms}&limit=1000")
    req = urllib.request.Request(url, headers={"User-Agent": "wicktor-r-path"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            j = json.loads(resp.read())
    except Exception:
        return None
    if not j or j.get("retCode") != 0 or not j.get("result", {}).get("list"):
        return None
    return sorted([[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4])]
                   for x in j["result"]["list"]], key=lambda x: x[0])


out = []
symbols = sorted(by_symbol.keys())
n_ok = n_fail = 0

for i, (symbol, market) in enumerate(symbols):
    trades = by_symbol[(symbol, market)]
    lo = min(t["bar_time"] for t in trades) - BAR_MS
    hi = max(t["bar_time"] for t in trades) + HOLD_BARS * BAR_MS + BAR_MS
    category = "linear" if market == "PERP" else "spot"
    bars = fetch_klines(symbol, category, lo, hi)
    if not bars:
        n_fail += 1
        continue
    n_ok += 1

    for t in trades:
        entry = float(t["entry"])
        risk = abs(entry - float(t["stop"]))
        if risk <= 0 or entry <= 0:
            continue
        direction = t["direction"]
        start = t["bar_time"]
        window = [b for b in bars if start <= b[0] <= start + HOLD_BARS * BAR_MS]
        if not window:
            continue

        path = []
        for (bt, o, h, l, c) in window:
            fav_px = h if direction == 1 else l
            adv_px = l if direction == 1 else h
            fav_r = (direction * (fav_px - entry)) / risk
            adv_r = (direction * (entry - adv_px)) / risk
            close_r = (direction * (c - entry)) / risk
            path.append([round(fav_r, 4), round(adv_r, 4), round(close_r, 4)])

        out.append({
            "symbol": symbol,
            "market": market,
            "dir": direction,
            "riskPct": risk / entry * 100,     # stop distance as % of price -> fee burden
            "recordedExit": t.get("exit_reason"),
            "outcomeA": t.get("outcome_a"),
            "origTargetR": abs(float(t["target"]) - entry) / risk,
            "bars": path,
        })

    if i % 100 == 0:
        print(f"  {i}/{len(symbols)} symbols, ok={n_ok} fail={n_fail}, {len(out)} paths", flush=True)

print(f"\nDone. {n_ok} ok, {n_fail} failed. {len(out)} R-paths extracted.")
with open("./r_paths.json", "w") as f:
    json.dump(out, f)

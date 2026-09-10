#!/usr/bin/env python3
"""Corrected stop-tightening test: unlike mae-live-check.py (which used a
naive single flat stop, no partials), this ports the REAL live exit logic
from js/signals.js realisedR() -- 1/3 out at 1/3-of-target (stop -> breakeven),
another 1/3 out at 2/3-of-target (stop -> locks in 1/3R profit), final 1/3
rides to full target -- and only shrinks the INITIAL pre-partial stop
distance by `fraction`. The real target price and the partial/breakeven
rungs are left exactly as-is, matching how tightening the SL would actually
behave live. Fetches the same real Bybit M5 candles as mae-live-check.py."""
import json
import urllib.request
from collections import defaultdict

BYBIT = "https://api.bybit.com"
TAKER = 0.11  # % of notional, round trip -- same simplified single-round-trip
              # approximation used throughout this thread (plan_a's extra
              # partial fills would add a bit more real fee than this models;
              # not re-derived here, consistent with prior methodology).
FRACTIONS = [1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2]
PLAN_A = [(1 / 3, 1 / 3, 0), (2 / 3, 1 / 3, 1 / 3), (1, 1 / 3, None)]

with open("./v22_rows.json") as f:
    rows = json.load(f)
rows = [r for r in rows if r.get("resolved_bar_time") and r.get("entry") and r.get("stop") and r.get("target")]
print(f"{len(rows)} usable rows")

by_symbol = defaultdict(list)
for r in rows:
    by_symbol[(r["symbol"], r["market"])].append(r)
print(f"{len(by_symbol)} distinct symbol/market pairs")


def fetch_klines(symbol, category, start_ms, end_ms):
    url = (f"{BYBIT}/v5/market/kline?category={category}&symbol={symbol}"
           f"&interval=5&start={start_ms}&end={end_ms}&limit=1000")
    req = urllib.request.Request(url, headers={"User-Agent": "wicktor-plana-tighten-check"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            j = json.loads(resp.read())
    except Exception:
        return None
    if not j or j.get("retCode") != 0 or not j.get("result", {}).get("list"):
        return None
    return sorted([[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5])]
                   for x in j["result"]["list"]], key=lambda x: x[0])


def realised_r(bars, direction, entry, risk, target_dist, fraction):
    """Direct port of js/signals.js realisedR(), fed a shrunk initial risk.
    TP/lock-in price levels fall out of target_dist directly (they cancel
    the risk term algebraically, same as the live code) -- only the
    pre-first-partial stop distance actually changes with `fraction`."""
    new_risk = risk * fraction
    target_r = target_dist / new_risk
    stop_r, remaining, realised, rung, reason = -1.0, 1.0, 0.0, 0, "timeout"
    last_c = entry
    for (t, o, h, l, c, v) in bars:
        last_c = c
        stop_px = entry + direction * stop_r * new_risk
        stop_hit = (l <= stop_px) if direction == 1 else (h >= stop_px)
        if stop_hit:
            realised += remaining * stop_r
            return {"r": realised, "reason": "breakeven" if stop_r >= 0 else "stop"}
        while rung < len(PLAN_A):
            frac_of_target, frac, new_stop = PLAN_A[rung]
            mult = frac_of_target * target_r
            tp = entry + direction * mult * new_risk
            hit = (h >= tp) if direction == 1 else (l <= tp)
            if not hit:
                break
            take = min(frac, remaining)
            realised += take * mult
            remaining -= take
            rung += 1
            if new_stop is not None:
                stop_r = new_stop * target_r
            if remaining <= 1e-9:
                return {"r": realised, "reason": "target"}
    exit_r = realised + remaining * ((direction * (last_c - entry)) / new_risk)
    risk_pct_new = new_risk / entry * 100
    return {"r": exit_r, "reason": reason, "net_fee": TAKER / risk_pct_new}


def walk_all_fractions(bars, direction, entry, risk, target_dist):
    out = {}
    for f in FRACTIONS:
        res = realised_r(bars, direction, entry, risk, target_dist, f)
        new_risk = risk * f
        risk_pct_new = new_risk / entry * 100
        res["net"] = res["r"] - TAKER / risk_pct_new
        out[str(f)] = res
    return out


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
        by_fraction = walk_all_fractions(window, direction, entry, risk, target_dist)
        base = by_fraction["1.0"]
        results.append({
            "symbol": symbol, "market": market, "dir": direction,
            "outcome_a": t.get("outcome_a"), "recorded_exit": t.get("exit_reason"),
            "reason": base["reason"], "r": base["r"],
            "byFraction": by_fraction,
        })
    if i % 100 == 0:
        print(f"  {i}/{len(symbol_list)} symbols, ok={n_ok} fail={n_fail}, {len(results)} trades", flush=True)

print(f"\nDone. {n_ok} ok, {n_fail} failed. {len(results)} trades walked.")
with open("./plana_tighten_results.json", "w") as f:
    json.dump(results, f)

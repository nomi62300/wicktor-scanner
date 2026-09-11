#!/usr/bin/env python3
"""Same as extract-r-paths.py but over a 12h hold window instead of 4h.

WHY: the engine's 48-bar (4h) timeout was calibrated when the target was
0.16-0.59R. A 1R target on a 2% stop needs a 2% move, which is a lot to
ask inside 4h — so the bigger targets that tested well may simply be
running out of clock rather than failing. Extracting 12h once lets any
shorter window (4h, 6h, 8h) be tested by truncating the path, so this
answers the whole question with a single fetch.

REQUIRES PAGINATION, unlike the 4h version. Per symbol the range spans
(first trade -> last trade + hold), which across a ~4-day trade history
plus 12h is ~1300 5M bars, over Bybit's 1000-bar per-request cap. The 4h
version fitted under the cap for nearly every symbol (verified: 96.5% of
its paths came back complete, and the short ones were simply recent
trades whose window had not finished elapsing). At 12h it would not, and
silent truncation would bias exactly the trades this test is about.
"""
import json
import time
import urllib.request
from collections import defaultdict

BYBIT = "https://api.bybit.com"
HOLD_BARS = 144                      # 144 x 5M = 12h
BAR_MS = 5 * 60 * 1000
PAGE = 1000

with open("./v22_rows.json") as f:
    rows = json.load(f)
rows = [r for r in rows if r.get("entry") and r.get("stop") and r.get("target")]
print(f"{len(rows)} usable rows, hold window {HOLD_BARS} bars ({HOLD_BARS*5/60:.0f}h)")

by_symbol = defaultdict(list)
for r in rows:
    by_symbol[(r["symbol"], r["market"])].append(r)
print(f"{len(by_symbol)} distinct symbol/market pairs")


def fetch_page(symbol, category, start_ms, end_ms):
    url = (f"{BYBIT}/v5/market/kline?category={category}&symbol={symbol}"
           f"&interval=5&start={start_ms}&end={end_ms}&limit={PAGE}")
    req = urllib.request.Request(url, headers={"User-Agent": "wicktor-r-path-long"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                j = json.loads(resp.read())
            if j.get("retCode") != 0:
                return []
            return [[int(x[0]), float(x[2]), float(x[3]), float(x[4])]
                    for x in j.get("result", {}).get("list", [])]   # t, high, low, close
        except Exception:
            time.sleep(0.4 * (attempt + 1))
    return []


def fetch_all(symbol, category, lo, hi):
    """Pages forward until the whole range is covered."""
    out = {}
    cursor = lo
    while cursor < hi:
        page = fetch_page(symbol, category, cursor, hi)
        if not page:
            break
        for b in page:
            out[b[0]] = b
        oldest = min(b[0] for b in page)
        newest = max(b[0] for b in page)
        # Bybit returns newest-first and caps at PAGE; advance past what we got.
        if newest <= cursor or len(page) < PAGE:
            if len(page) < PAGE:
                break
        nxt = newest + BAR_MS
        if nxt <= cursor:
            break
        cursor = nxt
    return sorted(out.values(), key=lambda x: x[0])


out = []
symbols = sorted(by_symbol.keys())
n_ok = n_fail = 0

for i, (symbol, market) in enumerate(symbols):
    trades = by_symbol[(symbol, market)]
    lo = min(t["bar_time"] for t in trades) - BAR_MS
    hi = max(t["bar_time"] for t in trades) + HOLD_BARS * BAR_MS + BAR_MS
    category = "linear" if market == "PERP" else "spot"
    bars = fetch_all(symbol, category, lo, hi)
    if not bars:
        n_fail += 1
        continue
    n_ok += 1
    index = {b[0]: b for b in bars}

    for t in trades:
        entry = float(t["entry"])
        risk = abs(entry - float(t["stop"]))
        if risk <= 0 or entry <= 0:
            continue
        direction = t["direction"]
        start = t["bar_time"]

        path = []
        for k in range(HOLD_BARS + 1):
            b = index.get(start + k * BAR_MS)
            if b is None:
                continue
            _, h, l, c = b
            fav_px = h if direction == 1 else l
            adv_px = l if direction == 1 else h
            path.append([
                round((direction * (fav_px - entry)) / risk, 4),
                round((direction * (entry - adv_px)) / risk, 4),
                round((direction * (c - entry)) / risk, 4),
            ])
        if not path:
            continue

        out.append({
            "symbol": symbol, "market": market, "dir": direction,
            "riskPct": risk / entry * 100,
            "recordedExit": t.get("exit_reason"),
            "origTargetR": abs(float(t["target"]) - entry) / risk,
            "bars": path,
        })

    if i % 100 == 0:
        print(f"  {i}/{len(symbols)} symbols, ok={n_ok} fail={n_fail}, {len(out)} paths", flush=True)

lens = [len(p["bars"]) for p in out]
full = sum(1 for l in lens if l >= HOLD_BARS + 1)
print(f"\nDone. {n_ok} ok, {n_fail} failed. {len(out)} paths.")
print(f"Full-length paths: {full} ({full/len(out)*100:.1f}%)  median bars {sorted(lens)[len(lens)//2]}")
with open("./r_paths_long.json", "w") as f:
    json.dump(out, f)

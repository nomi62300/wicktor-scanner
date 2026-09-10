import urllib.request
import json

REST = "https://fpyfetynfobfrpunnnhv.supabase.co/rest/v1/signal_journal"
KEY = "sb_publishable_95VI9mw_oHduFoqUlToCmg_CpfPucLC"
COLS = "symbol,market,direction,entry,stop,target,risk_pct,bar_time,resolved_bar_time,status,resolved_at,outcome_a,outcome_b,exit_reason,model_version"

def fetch_all(filt):
    rows = []
    offset = 0
    page = 1000
    while True:
        url = f"{REST}?select={COLS}&{filt}&order=id.asc"
        req = urllib.request.Request(url, headers={
            "apikey": KEY, "Authorization": f"Bearer {KEY}",
            "Range": f"{offset}-{offset+page-1}",
        })
        with urllib.request.urlopen(req) as resp:
            chunk = json.loads(resp.read())
        if not chunk: break
        rows.extend(chunk)
        if len(chunk) < page: break
        offset += page
    return rows

rows = fetch_all("model_version=eq.v2.2-near-target&status=eq.resolved")
print(f"Fetched {len(rows)} resolved v2.2 rows")
symbols = sorted(set((r["symbol"], r["market"]) for r in rows))
print(f"Distinct (symbol, market) pairs: {len(symbols)}")
bar_times = [r["bar_time"] for r in rows]
resolved_times = [r["resolved_bar_time"] for r in rows if r.get("resolved_bar_time")]
print(f"bar_time range: {min(bar_times)} to {max(bar_times)}")
if resolved_times:
    print(f"resolved_bar_time range: {min(resolved_times)} to {max(resolved_times)}")
print("exit_reason counts:", {r: sum(1 for x in rows if x.get("exit_reason")==r) for r in set(x.get("exit_reason") for x in rows)})
with open("./v22_rows.json", "w") as f:
    json.dump(rows, f)

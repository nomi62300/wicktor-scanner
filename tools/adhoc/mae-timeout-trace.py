import json
import statistics

with open("./mae_results.json") as f:
    results = json.load(f)

timeouts = [r for r in results if r["reason"] == "timeout"]
print(f"Timeout trades (under current 1.0x stop): n={len(timeouts)}\n")

# What were they ACTUALLY doing when they timed out, under the current stop?
orig_r = [r["byFraction"]["1.0"]["r"] for r in timeouts]
print("Their natural outcome R at the moment they timed out (nothing forced, just where price was):")
print(f"  mean={statistics.mean(orig_r):+.4f}R  positive={sum(1 for v in orig_r if v>0)}  "
      f"({sum(1 for v in orig_r if v>0)/len(orig_r)*100:.1f}%)  "
      f"negative={sum(1 for v in orig_r if v<0)}  ({sum(1 for v in orig_r if v<0)/len(orig_r)*100:.1f}%)  "
      f"flat={sum(1 for v in orig_r if v==0)}")
srt = sorted(orig_r)
def pct(p): return srt[int(len(srt)*p)]
print(f"  p10={pct(0.1):+.4f}  p25={pct(0.25):+.4f}  p50={pct(0.5):+.4f}  p75={pct(0.75):+.4f}  p90={pct(0.9):+.4f}")

print("\nWhat happens to these SAME 1,153 trades as the stop tightens:")
print(f"  {'fraction':10s} {'-> stop':>9s} {'-> target':>10s} {'still timeout':>14s} {'R of newly-stopped (was)':>26s}")
FRACTIONS = ["1.0", "0.85", "0.7", "0.55", "0.4", "0.3", "0.2"]
for f in FRACTIONS:
    became_stop = [r for r in timeouts if r["byFraction"][f]["reason"] == "stop"]
    became_target = [r for r in timeouts if r["byFraction"][f]["reason"] == "target"]
    still_timeout = [r for r in timeouts if r["byFraction"][f]["reason"] == "timeout"]
    if became_stop:
        was_r = [r["byFraction"]["1.0"]["r"] for r in became_stop]
        was_mean = statistics.mean(was_r)
        was_pos = sum(1 for v in was_r if v > 0) / len(was_r) * 100
        detail = f"was {was_mean:+.3f}R avg, {was_pos:.0f}% were >0"
    else:
        detail = "--"
    print(f"  {f+'x':10s} {len(became_stop):9d} {len(became_target):10d} {len(still_timeout):14d}   {detail}")

print("\nNet R contribution of the timeout bucket alone, by fraction:")
for f in FRACTIONS:
    vals = [r["byFraction"][f]["net"] for r in timeouts]
    print(f"  {f}x: mean net = {statistics.mean(vals):+.4f}R  (n={len(vals)})")

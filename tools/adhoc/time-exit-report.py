import json
import statistics

with open("./time_exit_results.json") as f:
    results = json.load(f)

n = len(results)
CUTOFFS_MIN = [240, 180, 150, 120, 90, 60, 30]
print(f"Total trades: {n}\n")
print(f"{'cutoff':>8s} {'win%':>7s} {'gross R':>9s} {'NET R':>9s}  {'stop':>6s} {'target':>7s} {'time_exit':>10s}")
for cm in CUTOFFS_MIN:
    sub = [r["byCutoff"][str(cm)] for r in results]
    win = sum(1 for s in sub if s["r"] > 0) / n * 100
    gross = statistics.mean(s["r"] for s in sub)
    net = statistics.mean(s["net"] for s in sub)
    n_stop = sum(1 for s in sub if s["reason"] == "stop")
    n_target = sum(1 for s in sub if s["reason"] == "target")
    n_time = sum(1 for s in sub if s["reason"] in ("time_exit", "timeout"))
    label = f"{cm}min" if cm < 240 else "240min(cur)"
    print(f"{label:>8s} {win:6.1f}% {gross:+9.4f} {net:+9.4f}  {n_stop:6d} {n_target:7d} {n_time:10d}")

print("\n--- Trades that were ORIGINALLY 'timeout' at 240min -- what does an earlier cutoff do to them? ---")
orig_timeout = [r for r in results if r["byCutoff"]["240"]["reason"] == "timeout"]
print(f"n={len(orig_timeout)}")
print(f"{'cutoff':>8s} {'their R now':>12s} {'was -> now: stop':>18s} {'target':>7s} {'still time_exit':>16s}")
for cm in CUTOFFS_MIN[1:]:
    sub = [r["byCutoff"][str(cm)] for r in orig_timeout]
    r_mean = statistics.mean(s["r"] for s in sub)
    n_stop = sum(1 for s in sub if s["reason"] == "stop")
    n_target = sum(1 for s in sub if s["reason"] == "target")
    n_time = sum(1 for s in sub if s["reason"] == "time_exit")
    print(f"{cm}min{'':<3s} {r_mean:+12.4f} {n_stop:18d} {n_target:7d} {n_time:16d}")

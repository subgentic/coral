#!/usr/bin/env python3
"""Turns routes.json and browser.json (and the seed log) of a baseline run into one markdown report: the route table, the screen table, the server's CPU and memory, and the slowest paths ranked.

  report.py OUTDIR > report.md
"""
import json, os, sys

def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return None

d = sys.argv[1]
r, b = load(os.path.join(d, "routes.json")), load(os.path.join(d, "browser.json"))
commit = open(os.path.join(d, "commit.txt")).read().strip() if os.path.exists(os.path.join(d, "commit.txt")) else "?"
print("# Goal #85 baseline (#9086)\n")
print("Commit measured: `%s`. One connection, no load; times in ms.\n" % commit[:12])
if r:
    print("## Hot routes (n=%d per route, after 3 warm-up requests)\n" % r["n"])
    print("| route | status | p50 | p95 | p99 | max | bytes |\n|---|---|---:|---:|---:|---:|---:|")
    for x in r["routes"]:
        print("| %s | %s | %s | %s | %s | %s | %s |" % (x["name"], ", ".join("%s x%s" % (k, v) for k, v in sorted(x["status"].items())), x["p50_ms"], x["p95_ms"], x["p99_ms"], x["max_ms"], x["bytes"]))
    bad = [x for x in r["routes"] if any(not str(k).startswith("2") for k in x["status"])]
    if bad:
        print("\n**Routes that answered something other than 2xx (their times are not a read's):**\n")
        for x in bad:
            print("- %s: %s" % (x["name"], x["status"]))
    else:
        print("\nEvery route answered 2xx on every request.")
    s = r.get("server") or {}
    print("\nServer while the routes ran: RSS max %s MB (avg %s), CPU %s s over %s s wall (%s%% of one core).\n" % (s.get("rss_mb_max"), s.get("rss_mb_avg"), s.get("cpu_seconds"), s.get("wall_seconds"), s.get("cpu_percent_of_one_core")))
if b:
    print("## Dashboard screens (median of %d runs; Chrome headless at %s x CPU throttle 1)\n" % (b["runs"], b.get("throttle", 1)))
    print("| screen | wall median | wall worst | main-thread task | script | layout | long tasks (n / ms) | requests | KB | slowest finished request | still open after 8 s at settle |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for x in b["screens"]:
        ab = "; ".join("%s x%s, %s ms" % (a["url"], a["runs"], a["maxAgeMs"]) for a in x.get("abandoned", [])) or ""
        print("| %s | %s | %s | %d | %d | %d | %s / %d | %s | %s | %s | %s |" % (x["name"], x["wallMedianMs"], x["wallWorstMs"], round(x["taskMs"] or 0), round(x["scriptMs"] or 0), round(x["layoutMs"] or 0), x["longTasks"], round(x["longMs"] or 0), x["requests"], x["kb"], x["slowest"], ab))
print("\n## Slowest routes (by p95, one connection)\n")
if r:
    for i, x in enumerate(sorted(r["routes"], key=lambda x: -x["p95_ms"])[:10], 1):
        print("%d. **%s**: p95 %s ms, %s bytes" % (i, x["name"], x["p95_ms"], x["bytes"]))
if b:
    print("\n## Slowest screens (by median wall time; a screen includes the routes it calls, so these are ranked apart from the routes)\n")
    for i, x in enumerate(sorted(b["screens"], key=lambda x: -(x["wallMedianMs"] or 0))[:10], 1):
        print("%d. **%s**: median %s ms, %s requests" % (i, x["name"], x["wallMedianMs"], x["requests"]))

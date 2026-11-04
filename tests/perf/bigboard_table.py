#!/usr/bin/env python3
# bigboard_table.py OUTDIR  (#13154): the ranked table (worst first) from OUTDIR/local.json and, if there, hub.json. Markdown on stdout.
import json, os, sys

d = sys.argv[1]
runs = {n: json.load(open(os.path.join(d, n + ".json"))) for n in ("local", "hub") if os.path.exists(os.path.join(d, n + ".json"))}
print("# Big-board baseline (#13154)\n")
fx = os.path.join(d, "..", "fixture.json")
for n, r in runs.items():
    L = r["load"]
    print("## %s: %s\n" % (n, r["base"]))
    print("- first load: agent list at %d ms, requests settled at %d ms, %d API requests + %d static files; FCP %s ms" % (L["ms_to_agent_list"], L["ms_to_settled"], L["requests"], L["static_files"], round((L["nav"] or {}).get("fcp") or 0)))
    print("- idle: %d requests in %d s" % (r["idle"]["requests"], r["idle"]["seconds"]))
    for k, v in r["interactions"].items():
        print("- %s: %s" % (k, json.dumps(v)))
    print("\n| rank | phase | route | n | p50 ms | p95 ms | max ms | bytes each | statuses |\n|---|---|---|---|---|---|---|---|---|")
    for i, x in enumerate([x for x in r["routes"] if x["route"] != "GET /"][:40], 1):
        print("| %d | %s | `%s` | %d | %s | %s | %s | %d | %s |" % (i, x["phase"], x["route"], x["n"], x["p50"], x["p95"], x["max"], x["bytes_each"], json.dumps(x["status"])))
    print()
if len(runs) == 2:
    loc = {(x["phase"], x["route"]): x for x in runs["local"]["routes"]}
    print("## through the hub vs local (same route, p95 ms; ratio)\n\n| route | phase | local | hub | ratio |\n|---|---|---|---|---|")
    rows = [(x["p95"] / max(loc[(x["phase"], x["route"])]["p95"], 0.1), x, loc[(x["phase"], x["route"])]) for x in runs["hub"]["routes"] if (x["phase"], x["route"]) in loc]
    for ratio, h, l in sorted(rows, key=lambda t: -t[0])[:20]:
        print("| `%s` | %s | %s | %s | %.1fx |" % (h["route"], h["phase"], l["p95"], h["p95"], ratio))

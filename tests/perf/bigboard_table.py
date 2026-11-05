#!/usr/bin/env python3
# bigboard_table.py OUTDIR  (#13154): the ranked table (worst first) from OUTDIR/local-<n>.json (n live agents) and hub-<n>.json. Markdown on stdout.
# Sections: per run the first load, idle polls and timed interactions, then the routes worst p95 first; /poll and capture routes by agent count;
# and through the hub against local at the same agent count.
import glob, json, os, re, sys

d = sys.argv[1]
runs = {}
for f in glob.glob(os.path.join(d, "*-*.json")):
    m = re.match(r"(local|hub)-(\d+)\.json$", os.path.basename(f))
    if m:
        runs[(m.group(1), int(m.group(2)))] = json.load(open(f))
order = sorted(runs, key=lambda k: (k[0] != "local", k[1]))
print("# Big-board baseline (#13154)\n")
for k in order:
    r = runs[k]; L = r["load"]
    print("## %s, %d live agents: %s\n" % (k[0], k[1], r["base"]))
    print("- first load: agent list at %d ms, requests settled at %d ms, %d API requests + %d static files; FCP %s ms" % (L["ms_to_agent_list"], L["ms_to_settled"], L["requests"], L["static_files"], round((L["nav"] or {}).get("fcp") or 0)))
    print("- idle: %d requests in %d s" % (r["idle"]["requests"], r["idle"]["seconds"]))
    for name, v in r["interactions"].items():
        print("- %s: %s" % (name, json.dumps(v)))
    print("\n| rank | phase | route | n | p50 ms | p95 ms | max ms | bytes each | statuses |\n|---|---|---|---|---|---|---|---|---|")
    for i, x in enumerate([x for x in r["routes"] if x["route"] != "GET /"][:40], 1):
        print("| %d | %s | `%s` | %d | %s | %s | %s | %d | %s |" % (i, x["phase"], x["route"], x["n"], x["p50"], x["p95"], x["max"], x["bytes_each"], json.dumps(x["status"])))
    print()
loc = [k for k in order if k[0] == "local"]
if len(loc) > 1:
    print("## /poll, capture and event routes by live-agent count (local; p50 / p95 / max ms, n)\n")
    keys = sorted({(x["phase"], x["route"]) for k in loc for x in runs[k]["routes"] if re.search(r"poll|capture|event|worktree|files", x["route"])})
    print("| phase | route | " + " | ".join("%d agents" % k[1] for k in loc) + " |\n|---|---|" + "---|" * len(loc))
    for ph, ro in keys:
        cells = []
        for k in loc:
            x = next((y for y in runs[k]["routes"] if (y["phase"], y["route"]) == (ph, ro)), None)
            cells.append("%s / %s / %s (n=%d)" % (x["p50"], x["p95"], x["max"], x["n"]) if x else "-")
        print("| %s | `%s` | %s |" % (ph, ro, " | ".join(cells)))
    print()
for hk in [k for k in order if k[0] == "hub"]:
    lk = ("local", hk[1])
    if lk not in runs:
        continue
    L = {(x["phase"], x["route"]): x for x in runs[lk]["routes"]}
    print("## through the hub vs local at %d live agents (hub path folded; p95 ms; ratio)\n\n| hub route | phase | hub p95 | local p95 (same route) | ratio |\n|---|---|---|---|---|" % hk[1])
    rows = []
    for x in runs[hk]["routes"]:
        base = x["route"].replace("/api/remote/bigboard", "")
        base = re.sub(r"^(\w+) /api/remote/\w+", r"\1", x["route"])
        l = L.get((x["phase"], base)) or L.get((x["phase"], x["route"]))
        if l:
            rows.append((x["p95"] / max(l["p95"], 0.1), x, l))
    for ratio, h, l in sorted(rows, key=lambda t: -t[0])[:20]:
        print("| `%s` | %s | %s | %s | %.1fx |" % (h["route"], h["phase"], h["p95"], l["p95"], ratio))
    print()

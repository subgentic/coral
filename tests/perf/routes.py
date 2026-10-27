#!/usr/bin/env python3
"""Hot-route baseline for the Goal #85 measure (#9086): p50/p95/p99/max of the dashboard's everyday reads against a seeded isolated Coral server, one connection (no load), plus the server's CPU
and memory while they run (Linux only: /proc; on another system they are null).

  routes.py --base http://127.0.0.1:PORT --targets targets.json --pid SERVERPID [--key KEY] [--n 30] [--out routes.json]

It only reads. It refuses port 8420 and any base that is not a loopback address. Each route has 3 warm-up requests, then n timed ones; the time is the whole response read (headers sent to last byte).
"""
import argparse, http.client, json, math, os, sys, threading, time, urllib.parse

def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, math.ceil(p / 100.0 * len(xs)) - 1))] if xs else 0.0

class Sampler(threading.Thread):
    def __init__(self, pid):
        super().__init__(daemon=True)
        self.pid, self.stop_ev, self.rss, self.cpu0 = pid, threading.Event(), [], self.cpu()
        self.t0 = time.time()

    def cpu(self):
        try:
            with open(f"/proc/{self.pid}/stat") as f:
                parts = f.read().rsplit(")", 1)[1].split()
            return (int(parts[11]) + int(parts[12])) / os.sysconf("SC_CLK_TCK")
        except Exception:
            return None

    def mem(self):
        try:
            with open(f"/proc/{self.pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        return int(line.split()[1]) / 1024.0
        except Exception:
            return None

    def run(self):
        while not self.stop_ev.wait(0.25):
            m = self.mem()
            if m is not None:
                self.rss.append(m)

    def result(self):
        c = self.cpu()
        wall = time.time() - self.t0
        return {"rss_mb_max": round(max(self.rss), 1) if self.rss else None, "rss_mb_avg": round(sum(self.rss) / len(self.rss), 1) if self.rss else None,
                "cpu_seconds": round(c - self.cpu0, 2) if c is not None and self.cpu0 is not None else None, "wall_seconds": round(wall, 1),
                "cpu_percent_of_one_core": round(100 * (c - self.cpu0) / wall, 1) if c is not None and self.cpu0 is not None and wall else None}

def routes(t):
    b, ids = t["board_id"], t.get("sample_task_ids") or [1]
    s0 = t["session_names"][0] if t.get("session_names") else "claude-x"
    sid = t["session_ids"][0] if t.get("session_ids") else "x"
    g = (t.get("goal_ids") or [1])[0]
    now = int(time.time())
    return [
        ("tasks: default (open + first done page)", f"/api/board/{b}/tasks"),
        ("tasks: open, limit 50", f"/api/board/{b}/tasks?status=open&limit=50"),
        ("tasks: completed, limit 50", f"/api/board/{b}/tasks?status=completed&limit=50"),
        ("tasks: all, limit 200", f"/api/board/{b}/tasks?status=all&limit=200"),
        ("task detail", f"/api/board/{b}/tasks/{ids[0]}"),
        ("messages/all: newest 200", f"/api/board/{b}/messages/all?limit=200"),
        ("messages/all: dashboard format, 50", f"/api/board/{b}/messages/all?format=dashboard&limit=50"),
        ("messages/all: keyset page before id 30000", f"/api/board/{b}/messages/all?format=dashboard&limit=50&before_id=30000"),
        ("messages: for_subscriber (dashboard, 50)", f"/api/board/{b}/messages/all?for_subscriber=Lead&format=dashboard&limit=50"),
        ("messages/check (unread count)", f"/api/board/{b}/messages/check?subscriber_id=Lead"),
        ("messages/search q=progress", f"/api/board/{b}/messages/search?q=progress&limit=20"),
        ("subscribers", f"/api/board/{b}/subscribers"),
        ("board status (team availability)", f"/api/board/{b}/status"),
        ("board info", f"/api/board/{b}"),
        ("board projects list", "/api/board/projects"),
        ("board artifacts list", f"/api/board/{b}/artifacts"),
        ("goals list", f"/api/board/{b}/goals"),
        ("goal detail", f"/api/board/{b}/goals/{g}"),
        ("sessions/live (all agents)", "/api/sessions/live"),
        ("live agent info", f"/api/sessions/live/{s0}/info"),
        ("live agent chat", f"/api/sessions/live/{s0}/chat"),
        ("live agent poll", f"/api/sessions/live/{s0}/poll"),
        ("token-usage summary 30d", "/api/token-usage/summary?days=30"),
        ("token-usage by team", "/api/token-usage/by-team?days=30"),
        ("token-usage by branch", "/api/token-usage/by-branch?days=30"),
        ("token-usage timeseries", "/api/token-usage/timeseries?days=30"),
        ("token-usage turns", "/api/token-usage/turns?days=30"),
        ("analytics efficiency tokens/commit by provider (7d)", "/api/analytics/efficiency?metric=tokens_per_commit&group_by=provider&range=7d"),
        ("analytics efficiency task time by agent (30d)", "/api/analytics/efficiency?metric=task_time&group_by=agent&range=30d"),
        ("settings", "/api/settings"),
    ]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--targets", required=True); ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--key", default=os.environ.get("CORAL_API_KEY", "")); ap.add_argument("--n", type=int, default=30); ap.add_argument("--out", default="routes.json")
    a = ap.parse_args()
    u = urllib.parse.urlparse(a.base)
    if u.hostname not in ("127.0.0.1", "localhost", "::1") or not u.port or u.port == 8420:
        sys.exit("refusing %s: a loopback address on a port that is not 8420" % a.base)
    t = json.load(open(a.targets))
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=60)
    hdr = {"Origin": a.base, "Referer": a.base + "/", "Sec-Fetch-Site": "same-origin"}
    if a.key:
        hdr["Authorization"] = "Bearer " + a.key
    def get(path):
        t0 = time.perf_counter()
        conn.request("GET", path, headers=hdr)
        r = conn.getresponse(); body = r.read()
        return (time.perf_counter() - t0) * 1000.0, r.status, len(body)
    samp = Sampler(a.pid); samp.start()
    out = {"base": a.base, "n": a.n, "routes": []}
    for name, path in routes(t):
        for _ in range(3):
            get(path)
        ts, codes, size = [], {}, 0
        for _ in range(a.n):
            ms, code, size = get(path)
            ts.append(ms); codes[code] = codes.get(code, 0) + 1
        row = {"name": name, "path": path, "status": codes, "bytes": size, "p50_ms": round(pct(ts, 50), 1), "p95_ms": round(pct(ts, 95), 1), "p99_ms": round(pct(ts, 99), 1), "max_ms": round(max(ts), 1)}
        out["routes"].append(row)
        print("%-58s %5.0f %5.0f %5.0f  %8d B  %s" % (name, row["p50_ms"], row["p95_ms"], row["max_ms"], size, codes), flush=True)
    samp.stop_ev.set(); samp.join(1)
    out["server"] = samp.result()
    json.dump(out, open(a.out, "w"), indent=1)
    print("server:", out["server"])

if __name__ == "__main__":
    main()

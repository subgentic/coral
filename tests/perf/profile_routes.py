#!/usr/bin/env python3
"""CPU profile of the slowest routes of a baseline run (#9086, Goal #85): for each of the K slowest routes (by p95, from routes.json) one connection asks it again and again for S seconds while the
server's dev loopback profiler (CORAL_PPROF_ADDR) records a CPU profile, and `go tool pprof -top` prints where the time went.

  profile_routes.py --base http://127.0.0.1:PORT --pprof 127.0.0.1:PPROF --routes routes.json --out DIR [--k 6] [--seconds 15] [--key KEY] [--go go]

It only reads. It refuses port 8420 and any base that is not a loopback address.
"""
import argparse, http.client, json, os, subprocess, sys, threading, time, urllib.parse

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--pprof", required=True); ap.add_argument("--routes", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--k", type=int, default=6); ap.add_argument("--seconds", type=int, default=15); ap.add_argument("--key", default=os.environ.get("CORAL_API_KEY", "")); ap.add_argument("--go", default="go")
    a = ap.parse_args()
    u = urllib.parse.urlparse(a.base)
    if u.hostname not in ("127.0.0.1", "localhost", "::1") or not u.port or u.port == 8420:
        sys.exit("refusing %s: a loopback address on a port that is not 8420" % a.base)
    ph, _, pp = a.pprof.rpartition(":")
    if ph not in ("127.0.0.1", "localhost", "::1") or pp == "8420":
        sys.exit("refusing pprof address %s" % a.pprof)
    os.makedirs(a.out, exist_ok=True)
    rows = sorted(json.load(open(a.routes))["routes"], key=lambda x: -x["p95_ms"])[:a.k]
    hdr = {"Origin": a.base, "Referer": a.base + "/", "Sec-Fetch-Site": "same-origin"}
    if a.key:
        hdr["Authorization"] = "Bearer " + a.key
    report = []
    for i, r in enumerate(rows, 1):
        prof = os.path.join(a.out, "cpu_%02d.pb.gz" % i)
        cap = subprocess.Popen(["curl", "-s", "-o", prof, "http://%s/debug/pprof/profile?seconds=%d" % (a.pprof, a.seconds)])
        time.sleep(0.5)
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=60)
        n, end = 0, time.time() + a.seconds - 1
        while time.time() < end:
            conn.request("GET", r["path"], headers=hdr); conn.getresponse().read(); n += 1
        cap.wait()
        top = subprocess.run([a.go, "tool", "pprof", "-top", "-nodecount=25", prof], capture_output=True, text=True).stdout
        open(os.path.join(a.out, "cpu_%02d.top.txt" % i), "w").write(top)
        report.append("### %d. %s (p95 %s ms in the baseline; %d requests in %d s)\n\n```\n%s\n```\n" % (i, r["name"], r["p95_ms"], n, a.seconds - 1, "\n".join(top.splitlines()[:34])))
        print("profiled", r["name"], n, "requests", flush=True)
    open(os.path.join(a.out, "profile.md"), "w").write("# Goal #85: where the slowest routes spend CPU (#9086)\n\n" + "\n".join(report))

if __name__ == "__main__":
    main()

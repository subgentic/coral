#!/usr/bin/env python3
"""The availability list check (#15071) as a program: python3 availability_check.py LIST BASE_URL COOKIE_JAR.

Same logic as the block inside smoke_linux.sh and smoke_windows.ps1 (Security read those, #15393/#15395); the macOS app smoke (tools/test-macos-app.sh) calls
this file. Prints 'ok N checked (tier T)' and exits 0, or the failures and exits 1. The cookie jar already holds the dashboard sign-in."""
import json, os, shlex, subprocess, sys
lst, base, jar = sys.argv[1:4]
def get(path):
    out = subprocess.run(["curl", "-s", "-m", "10", "-b", jar, "-H", "Origin: " + base, "-H", "Sec-Fetch-Site: same-origin", base + path], capture_output=True, text=True).stdout
    return json.loads(out)
tier = ""
try: tier = get("/api/system/status").get("tier_name", "")
except Exception: pass
bad, checked, dropbox_line = [], 0, False
for line in open(lst):
    line = line.split("#", 1)[0].strip()
    if not line: continue
    w = shlex.split(line)
    ep, field, want = w[0], w[1], json.loads(w[2])
    opts = dict(x.split("=", 1) for x in w[3:])
    if "env" in opts and os.environ.get(opts["env"]) != "1": continue
    if "tier" in opts:
        if not tier: bad.append("%s %s has tier=%s but /api/system/status gave no tier_name: not checked" % (ep, field, opts["tier"])); continue
        if tier != opts["tier"]: continue
    checked += 1
    if ep == "/api/dropbox/status": dropbox_line = True
    try: got = get(ep).get(field, "<missing>")
    except Exception as e: got = "no answer (%s)" % type(e).__name__
    if got != want: bad.append("%s %s is %s, a release reports %s" % (ep, field, json.dumps(got), json.dumps(want)))
if checked == 0: bad.append("no line of the list was checked")
if os.environ.get("SMOKE_EXPECT_DROPBOX_KEY") == "1" and not dropbox_line: bad.append("SMOKE_EXPECT_DROPBOX_KEY=1 but no /api/dropbox/status line was checked")
print("ok %d checked (tier %s)" % (checked, tier or "unknown") if not bad else "; ".join(bad))
sys.exit(0 if not bad else 1)

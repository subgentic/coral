#!/usr/bin/env python3
# bigboard_uploads.py BASE ENVDIR NFILES NVERS OUT.json   (#13154)
#
# The artifact uploads of the big-board fixture, through the real route an agent's `coral-agent artifact upload` calls
# (POST /api/agent/artifacts): NFILES files, each uploaded NVERS times as a new version of the one before (the
# X-Artifact-New-Version-Of header), every version tagged "for review", by the mock agents of the seed (file n by agent
# n mod agents), each with its own session token from ENVDIR/<session>.env (the files MOCK_AGENT_ENV_DUMP makes). 200 x 100
# is the 20,000 uploads of the Operator's report. The server must have been built with the upload window raised (the seed
# script does that with a go build -overlay, never in the repo): the real one is 100 uploads per agent per hour.
# Stdlib only. The text of each version is fixed by the file and version numbers, so two runs seed the same bytes.
import json, os, sys, threading, time, urllib.parse, urllib.request, urllib.error

BASE, ENVDIR, NFILES, NVERS, OUT = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
WORKERS = int(os.environ.get("UPLOAD_WORKERS", "8"))

agents = []  # (session id, token)
for fn in sorted(os.listdir(ENVDIR)):
    if not fn.endswith(".env"):
        continue
    kv = dict(l.strip().split("=", 1) for l in open(os.path.join(ENVDIR, fn)) if "=" in l)
    if kv.get("CORAL_SESSION_TOKEN"):
        agents.append((fn[:-4], kv["CORAL_SESSION_TOKEN"]))
if not agents:
    sys.exit("no agent token files in " + ENVDIR)

lock = threading.Lock()
out = {"files": NFILES, "versions": NVERS, "agents": len(agents), "uploaded": 0, "failed": 0, "refused": {}}
todo = list(range(NFILES))


def body(n, v):
    line = "File %d, version %d. The reviewer reads this paragraph, changes one number and sends it back.\n" % (n, v)
    return (line * (6 + (n * 7 + v) % 40)).encode()


def upload(n, v, prev, sid, token):
    req = urllib.request.Request(
        BASE + "/api/agent/artifacts?session_id=%s&tag=for%%20review&question=%s" % (sid, urllib.parse.quote("Approve file %d, version %d?" % (n, v))), data=body(n, v), method="POST",
        headers={"X-Coral-Session-Token": token, "X-Artifact-Name": "file-%03d.md" % n, "X-Artifact-Media-Type": "text/markdown",
                 "X-Artifact-Task": "none", **({"X-Artifact-New-Version-Of": prev} if prev else {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as f:
                uri = json.loads(f.read()).get("uri", "")
                return uri.rsplit("/", 1)[-1]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(0.5 * (attempt + 1))
                continue
            with lock:
                out["refused"]["%d" % e.code] = e.read()[:200].decode("utf-8", "replace")
            return None
        except Exception:
            time.sleep(0.2)
    return None


def worker():
    while True:
        with lock:
            if not todo:
                return
            n = todo.pop()
        sid, token = agents[n % len(agents)]
        prev = ""
        for v in range(1, NVERS + 1):
            h = upload(n, v, prev, sid, token)
            with lock:
                out["uploaded" if h else "failed"] += 1
            if not h:
                break
            prev = h


t0 = time.time()
ths = [threading.Thread(target=worker) for _ in range(WORKERS)]
for t in ths:
    t.start()
for t in ths:
    t.join()
out["seconds"] = round(time.time() - t0, 1)
json.dump(out, open(OUT, "w"), indent=1)
print(json.dumps(out))
sys.exit(0 if out["failed"] == 0 else 1)

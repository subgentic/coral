#!/usr/bin/env python3
# bigboard_uploads.py BASE ENVDIR NFILES NVERS OUT.json   (#13154)
#
# The artifact uploads of the big-board fixture, through the real route an agent's `coral-agent artifact upload` calls
# (POST /api/agent/artifacts): NFILES files, each uploaded NVERS times as a new version of the one before (the
# X-Artifact-New-Version-Of header), every version tagged "for review", by the mock agents of the seed (file n by agent
# n mod agents), each with its own session token from ENVDIR/<session>.env (the files MOCK_AGENT_ENV_DUMP makes). 200 x 100
# is the 20,000 uploads of the Operator's report. The server must have been built with the upload window raised (the seed
# script does that with a go build -overlay, never in the repo): the real one is 100 uploads per agent per hour.
# LEDGER (optional, a JSONL file): every upload that lands is appended as {"n": file, "v": version, "hex": id}; a run that starts with a ledger
# carries on from each file's last recorded version (the chain continues as a new version of that id), so a stopped seed resumes. At most one
# upload per worker (8) can have landed without being recorded when the run was cut: that file then has one extra version. Exit code 3 means a
# token was refused (401/403: the agent's session is not alive any more), so the caller can launch new agents and run again.
# Stdlib only. The text of each version is fixed by the file and version numbers, so two runs seed the same bytes.
import json, os, sys, threading, time, urllib.parse, urllib.request, urllib.error

BASE, ENVDIR, NFILES, NVERS, OUT = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
LEDGER = sys.argv[6] if len(sys.argv) > 6 else ""
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
out = {"files": NFILES, "versions": NVERS, "agents": len(agents), "uploaded": 0, "failed": 0, "refused": {}, "resumed_from": 0, "token_refused": False}
done = {}  # file -> (last version, its id), from the ledger
if LEDGER and os.path.exists(LEDGER):
    for line in open(LEDGER):
        try:
            r = json.loads(line)
        except ValueError:
            continue  # a line cut by the stop
        done[r["n"]] = (r["v"], r["hex"])
    out["resumed_from"] = sum(v for v, _ in done.values())
todo = [n for n in range(NFILES) if done.get(n, (0, ""))[0] < NVERS]
ledger = open(LEDGER, "a", buffering=1) if LEDGER else None


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
                if e.code in (401, 403):
                    out["token_refused"] = True
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
        last, prev = done.get(n, (0, ""))
        for v in range(last + 1, NVERS + 1):
            if out["token_refused"]:
                return
            h = upload(n, v, prev, sid, token)
            with lock:
                out["uploaded" if h else "failed"] += 1
                if h and ledger:
                    ledger.write(json.dumps({"n": n, "v": v, "hex": h}) + "\n")
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
sys.exit(3 if out["token_refused"] else (0 if out["failed"] == 0 else 1))

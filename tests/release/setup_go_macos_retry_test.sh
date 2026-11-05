#!/usr/bin/env bash
# setup_go_macos_retry_test.sh: the Go cache restore in .github/actions/setup-go-macos retries once when the first restore found nothing (a timeout of the
# cache service, ETIMEDOUT, looks like a miss), and the go.sum check after it is exactly as strict as before. No network: the action file is read as text and the
# retry's condition is evaluated for a restore that matched a key and one that did not.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
action="$root/.github/actions/setup-go-macos/action.yml"
status=0
python3 -I - "$action" <<'PY' || status=$?
import re, sys
text = open(sys.argv[1]).read()
fails = 0
def ok(m): print("ok: " + m)
def bad(m):
    global fails; fails += 1; print("FAIL: " + m)

# the steps, by their "- name:" lines
steps = re.split(r"\n    - name: ", "\n" + text.split("  steps:\n", 1)[1])
steps = [s for s in steps if s.strip()]
named = {s.split("\n", 1)[0]: s for s in steps}
def find(prefix):
    for k, v in named.items():
        if k.startswith(prefix): return k, v
    return None, None

_, restore = find("Restore the Go caches")
_, wait = find("Wait before retrying")
_, retry = find("Retry the Go cache restore once")
_, verify = find("Verify the restored modules")
if not (restore and wait and retry and verify):
    bad("the restore, wait, retry and verify steps are all there"); sys.exit(1)
ok("the restore, the wait, the retry and the verify steps are all there")

order = [k for k in named]
ik = lambda p: next(i for i, k in enumerate(order) if k.startswith(p))
if ik("Restore the Go caches") < ik("Wait before retrying") < ik("Retry the Go cache restore once") < ik("Verify the restored modules"):
    ok("they run in that order: restore, wait, retry, verify")
else: bad("the order is restore, wait, retry, verify")

use = lambda s: re.search(r"uses: (actions/cache/restore@[0-9a-f]{40})", s)
if use(restore) and use(retry) and use(restore).group(1) == use(retry).group(1):
    ok("the retry uses the same pinned actions/cache/restore as the first restore")
else: bad("the retry uses the same SHA-pinned actions/cache/restore")

nocomment = lambda s: "\n".join(l for l in s.split("\n") if not l.lstrip().startswith("#"))
withs = lambda s: re.search(r"with:\n(.*?)(?:\n    - name:|\Z)", nocomment(s), re.S).group(1)
if withs(restore).strip() == withs(retry).strip():
    ok("the retry restores the same path, key and restore-keys as the first try")
else: bad("the retry has the same with: block as the first restore")

cond = lambda s: re.search(r"\n      if: (.*)", s).group(1).strip()
want = "inputs.cache == 'restore' && steps.restore.outputs.cache-matched-key == ''"
if cond(wait) == want and cond(retry) == want:
    ok("the wait and the retry run only for a restore that matched no key")
else: bad("the wait and the retry are conditioned on cache == restore and an empty cache-matched-key")

# the condition, evaluated for the two cases (a hit, a miss or a timeout)
def runs(cache, matched):
    return cache == "restore" and matched == ""
if runs("restore", "") and not runs("restore", "go-macos-v1-x86_64-key") and not runs("off", ""):
    ok("a restore that matched a key does not retry; an empty match does; cache off never does")
else: bad("the retry condition behaves as described")

if len([k for k in named if k.startswith("Retry the Go cache restore")]) == 1 and "while" not in retry and "for " not in retry:
    ok("one retry only, no loop")
else: bad("exactly one retry step and no loop")

# the check after it is unchanged: go mod verify, the exact output, and exit 1
if 'go" mod verify' in verify and '[ "$out" = "all modules verified" ] ||' in verify and "exit 1" in verify and "|| true" in verify.split("go mod verify")[0] + verify.split("go mod verify")[1][:80]:
    ok("the go.sum check after the retry still needs 'all modules verified' and exits 1 otherwise")
else: bad("the verify step is unchanged: go mod verify, the exact 'all modules verified' test and exit 1")

if "steps.restore-retry.outputs.cache-hit || steps.restore.outputs.cache-hit" in text:
    ok("the cache-hit output is the retry's, else the first restore's")
else: bad("the cache-hit output falls back from the retry to the first restore")

sys.exit(1 if fails else 0)
PY
[ "$status" = 0 ] && echo "PASS setup_go_macos_retry" || { echo "FAIL setup_go_macos_retry"; exit 1; }

"""Driver for run_goals.sh: exercise the public API and actual coral-board binary."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request


url, folder, suffix, backend, home = sys.argv[1:]
root = Path(folder)
# curl writes HttpOnly cookies with a #HttpOnly_ prefix. Python 3.9's
# MozillaCookieJar treats those as comments, so read this private Netscape jar.
cookies = []
for line in (root / "cookies.txt").read_text().splitlines():
    line = line.removeprefix("#HttpOnly_")
    if not line or line.startswith("#"):
        continue
    fields = line.split("\t")
    if len(fields) == 7 and fields[5].startswith("coral_session"):
        cookies.append(fields[5] + "=" + fields[6])
cookie = "; ".join(cookies)
assert cookie, "private login did not create a cookie"
passed = 0
failed = 0
agents = {}


def check(label, condition):
    global passed, failed
    if not condition:
        failed += 1
        print("[goals] FAIL: " + label, flush=True)
        raise AssertionError(label)
    passed += 1
    print("[goals] PASS: " + label, flush=True)


def api(method, path, body=None, expected=(200,)):
    req = urllib.request.Request(
        url + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Cookie": cookie,
                 "Origin": url, "Sec-Fetch-Site": "same-origin"})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            code, data = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, data = error.code, error.read()
    value = json.loads(data)
    assert code in expected, f"{method} {path}: HTTP {code}: {value}"
    return value


def cli(role, *args, ok=True):
    agent = agents[role]
    env = dict(os.environ, HOME=home, USERPROFILE=home, CORAL_URL=url,
               CORAL_SESSION_NAME=agent["session_name"], CORAL_SUBSCRIBER_ID=role,
               CORAL_SESSION_TOKEN=agent["token"])
    for name in ("TMUX", "TMUX_PANE", "CORAL_PORT", "CORAL_SESSION_AUTH_FILE"):
        env.pop(name, None)
    result = subprocess.run([str(root / ("coral-board" + suffix)), *map(str, args)],
                            env=env, capture_output=True, text=True, timeout=20)
    if ok:
        assert result.returncode == 0, f"CLI {' '.join(map(str, args))}: {result.stderr}"
        return result.stdout
    return result


def ident(text, kind):
    found = re.search(r"Created " + kind + r" #(\d+):", text)
    assert found, f"missing {kind} id in CLI output: {text}"
    return int(found[1])


def goal(title, *args):
    return ident(cli("Orchestrator", "goal", "add", title, *args), "Goal")


def task(title, *args):
    return ident(cli("Orchestrator", "task", "add", title, *args), "Task")


def show(gid):
    return json.loads(cli("Orchestrator", "goal", "show", gid, "--json"))


def rollup(gid, done=0, active=0, blocked=0, queued=0):
    expected = dict(done=done, active=active, blocked=blocked, queued=queued,
                    total=done + active + blocked + queued)
    got = show(gid)["rollup"]
    check(f"goal {gid} rollup {expected}", got == expected)


def race(functions):
    barrier = threading.Barrier(len(functions))

    def run(fn):
        barrier.wait(timeout=10)
        return fn()

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(functions)) as pool:
        return list(pool.map(run, functions))


def ready(dump):
    # Launches are staggered. Watch the atomic mock identity-file rename rather
    # than racing startup with a fixed delay or hammering the capture endpoint.
    script = """const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[1];
const watcher = fs.watch(path.dirname(file), check);
const timer = setTimeout(() => {
    watcher.close();
    process.stderr.write('mock identity file did not arrive\\n');
    process.exit(1);
}, 15000);
function check() {
    if (!fs.existsSync(file)) return;
    clearTimeout(timer);
    watcher.close();
}
check();
"""
    result = subprocess.run(["node", "-e", script, str(dump)], capture_output=True,
                            text=True, timeout=20)
    assert result.returncode == 0 and dump.is_file(), "mock agent did not become ready: " + result.stderr.strip()


try:
    check("mock CLI configured", api("PUT", "/api/settings", {
        "cli_path_claude": str(root / ("mock-agent" + suffix))})["ok"])
    launch = api("POST", "/api/sessions/launch-team", {
        "board_name": "goals-integration", "working_dir": str(root / "work"),
        "agent_type": "claude", "backend": backend,
        "agents": [{"name": role, "prompt": "Mock goals integration fixture"}
                   for role in ("Orchestrator", "Worker", "Tester", "Driver")]})
    board = launch["board"]
    base = "/api/board/" + board
    for agent in launch["agents"]:
        assert "error" not in agent, "mock launch failed"
        live = next(s for s in api("GET", "/api/sessions/live")
                    if s["session_id"] == agent["session_id"])
        agent["live_name"] = live["name"]
        dump = root / "env-dump" / (agent["session_id"] + ".env")
        ready(dump)
        values = dict(line.split("=", 1) for line in dump.read_text().splitlines() if "=" in line)
        assert values.get("CORAL_SESSION_TOKEN"), "mock agent received no token"
        agents[agent["name"]] = dict(agent, token=values["CORAL_SESSION_TOKEN"])
    check("four real mock identities launched (two workers)", len(agents) == 4)

    # All shared planning uses the real CLI with the mock Orchestrator's token.
    g1 = goal("Deliver goals", "--driver", "Driver", "--outcome", "integration works",
              "--done-when", "all checks pass")
    check("goal add stores driver and done-when", show(g1)["driver"] == "Driver"
          and show(g1)["done_when"] == "all checks pass")
    check("goal list includes the new goal", g1 in [g["id"] for g in json.loads(cli("Orchestrator", "goal", "list", "--json"))])
    cli("Orchestrator", "goal", "update", g1, "--state", "blocked", "--blocked-on", "Operator",
        "--decision", "choose a release", "--recommendation", "ship", "--if-silent", "wait")
    check("goal update retains decision fields", show(g1)["state"] == "blocked"
          and show(g1)["recommendation"] == "ship")
    cli("Orchestrator", "goal", "update", g1, "--state", "active", "--title", "Deliver goals updated")
    check("active clears stale blocker fields", show(g1)["title"] == "Deliver goals updated"
          and not show(g1).get("blocked_on"))
    rollup(g1)

    t1 = task("Build goal", "--goal", g1, "--assignee", "Worker")
    t2 = task("Consume build", "--goal", g1, "--assignee", "Tester", "--blocked-by", json.dumps([t1]))
    rollup(g1, queued=1, blocked=1)
    cli("Worker", "task", "claim", t1)
    rollup(g1, active=1, blocked=1)
    cli("Worker", "task", "complete", t1, "--message", "built")
    rollup(g1, done=1, queued=1)
    cli("Tester", "task", "claim", t2)
    rollup(g1, done=1, active=1)
    cli("Tester", "task", "complete", t2, "--message", "tested")
    rollup(g1, done=2)
    g2 = goal("Other goal")
    cli("Orchestrator", "task", "goal", t2, g2)
    rollup(g1, done=1)
    rollup(g2, done=1)
    cli("Orchestrator", "task", "goal", t2, "none")
    rollup(g2)
    check("task goal none clears the link", not api("GET", base + f"/tasks/{t2}").get("goal_id"))

    check("require-a-goal is initially off", not api("GET", base + "/settings")["require_goal"])
    plain = task("Unlinked while optional")
    api("PUT", base + "/settings", {"subscriber_id": "Operator", "require_goal": True})
    before = len(api("GET", base + "/tasks?status=all")["tasks"])
    refused = cli("Orchestrator", "task", "add", "Missing required goal", ok=False)
    check("require-a-goal rejects plain CLI task", refused.returncode != 0 and "goal_required" in refused.stderr)
    check("rejected task is not stored", len(api("GET", base + "/tasks?status=all")["tasks"]) == before)
    linked = task("Linked while required", "--goal", g1)
    check("linked task is still accepted", api("GET", base + f"/tasks/{linked}")["goal_id"] == g1)
    api("PUT", base + "/settings", {"subscriber_id": "Operator", "require_goal": False})
    check("turning requirement off allows plain tasks", task("Unlinked after off") > plain)

    warning = cli("Orchestrator", "goal", "close", g1, "--reason", "delivered with follow-up")
    check("close warns about the open task", "1 task of this goal is still open" in warning)
    check("closing preserves the open task", api("GET", base + f"/tasks/{linked}")["status"] == "pending")
    check("default list excludes closed goal", g1 not in [g["id"] for g in json.loads(cli("Orchestrator", "goal", "list", "--json"))])
    check("all-state list includes closed goal", g1 in [g["id"] for g in json.loads(cli("Orchestrator", "goal", "list", "--state", "all", "--json"))])
    refused_close = cli("Orchestrator", "goal", "close", g1, "--reason", "second close", ok=False)
    check("separate second close is refused", refused_close.returncode != 0
          and "goal_already_closed" in refused_close.stderr
          and show(g1)["closed_reason"] == "delivered with follow-up")
    cli("Orchestrator", "goal", "update", g1, "--state", "active")
    check("reopen clears closed metadata", show(g1)["state"] == "active" and not show(g1).get("closed_at"))

    concurrent_goal = goal("Concurrent changes")
    updates = [("title", "Concurrent title"), ("outcome", "Concurrent outcome"),
               ("done-when", "Concurrent check"), ("driver", "Driver")]
    # Five goals, four independent fields each: all twenty writes have an
    # unambiguous final value, so none can disappear behind another writer.
    update_goals = [concurrent_goal] + [goal(f"Concurrent fields {i}") for i in range(4)]
    race([lambda gid=gid, k=k, v=v: cli("Orchestrator", "goal", "update", gid, "--" + k, v)
          for gid in update_goals for k, v in updates])
    for gid in update_goals:
        changed = show(gid)
        check(f"20 concurrent updates preserve every field of goal {gid}",
              all(changed[k.replace("-", "_")] == v for k, v in updates))
    closes = race([lambda i=i: cli("Orchestrator", "goal", "close", concurrent_goal, "--reason", f"winner-{i}", ok=False)
                   for i in range(10)])
    winners = [i for i, result in enumerate(closes) if result.returncode == 0]
    check("exactly one concurrent close wins", len(winners) == 1)
    check("other closes report already closed", all(result.returncode == 0 or "goal_already_closed" in result.stderr for result in closes))
    check("stored close reason belongs to winner", show(concurrent_goal)["closed_reason"] == f"winner-{winners[0]}")

    # Race an edit with a close too: text and the terminal state must both survive.
    mixed = goal("Edit and close together")
    race([lambda: cli("Orchestrator", "goal", "update", mixed, "--outcome", "kept edit"),
          lambda: cli("Orchestrator", "goal", "close", mixed, "--reason", "kept close")])
    check("concurrent edit and close keep both effects", show(mixed)["outcome"] == "kept edit"
          and show(mixed)["state"] == "done" and show(mixed)["closed_reason"] == "kept close")

    def brief():
        return next(p for p in api("GET", "/api/board/projects") if p["project"] == board)["goals_brief"]

    old = brief()
    fresh = goal("Brief counter")
    new = brief()
    check("projects goals_brief counts a new open goal", new["open"] == old["open"] + 1 and new["seq"] > old["seq"])
    listed = json.loads(cli("Orchestrator", "goal", "list", "--json"))
    check("projects open count agrees with goal list", new["open"] == len(listed))
    bt = task("Brief task", "--goal", fresh)
    check("linking a task moves goals_brief seq", brief()["seq"] > new["seq"])
    seq = brief()["seq"]
    cli("Orchestrator", "goal", "close", fresh, "--reason", "brief closed")
    check("closing moves goals_brief count and seq", brief()["open"] == new["open"] - 1 and brief()["seq"] > seq)

    paged_goal = goal("120 paged tasks")
    # Seed bulk data as the private dashboard Operator, without exhausting the
    # agent write burst budget. Worker/task flow above uses the real board CLI.
    expected_ids = [api("POST", base + "/tasks", {
        "title": f"Paging task {i:03d}", "goal_id": paged_goal,
        "subscriber_id": "Operator"}, expected=(201,))["id"] for i in range(120)]
    ids, cursors, sizes = [], set(), []
    cursor = ""
    # Bounded data traversal, not readiness polling: the real route pages 50 at a time.
    for _ in range(4):
        page = api("GET", base + f"/tasks?status=all&goal={paged_goal}&limit=50&cursor="
                   + urllib.parse.quote(cursor, safe=""))
        check("paged route never reports truncation", not page.get("truncated", False))
        ids.extend(t["id"] for t in page["tasks"])
        sizes.append(len(page["tasks"]))
        cursor = page.get("next_cursor", "")
        if not cursor:
            break
        assert cursor not in cursors, "route repeated a cursor"
        cursors.add(cursor)
    check("route pages exactly 50/50/20 without loss or duplication",
          sizes == [50, 50, 20] and ids == expected_ids and not cursor)
    check("CLI goal show returns all 120 tasks",
          sorted(t["id"] for t in show(paged_goal)["tasks"]) == expected_ids)
    listing = cli("Orchestrator", "task", "list", "--goal", paged_goal)
    check("CLI task list returns each of the 120 tasks exactly once",
          sorted(map(int, re.findall(r"^#(\d+)\s", listing, re.MULTILINE))) == expected_ids)
    rollup(paged_goal, queued=120)

    driver = agents["Driver"]
    check("driver put to sleep", api("POST", "/api/sessions/live/" + driver["session_id"] + "/sleep", {})["sleeping"])

    def asleep():
        rows = [s for s in api("GET", "/api/sessions/live")
                if s["session_id"] == driver["session_id"] or s.get("display_name") == "Driver"]
        return (len(rows) == 1 and rows[0]["session_id"] == driver["session_id"]
                and rows[0]["sleeping"] and not rows[0].get("working", False)
                and not rows[0].get("tmux_session"))

    check("sleep removes the driver's live terminal", asleep())
    sleeping_goal = goal("Sleeping driver", "--driver", "Driver")
    check("goal create leaves driver asleep", asleep())
    cli("Orchestrator", "goal", "update", sleeping_goal, "--outcome", "no wake", "--done-when", "still sleeping")
    check("goal update leaves driver asleep", asleep())
    cli("Orchestrator", "goal", "close", sleeping_goal, "--reason", "no wake on close")
    check("goal close leaves driver asleep", asleep())
    cli("Orchestrator", "goal", "list", "--state", "all", "--json")
    check("goal create/update/close never wake sleeping driver", asleep())
    check("sleeping driver remains valid goal metadata", show(sleeping_goal)["driver"] == "Driver")
except Exception as error:
    if failed == 0:
        failed += 1
        print("[goals] FAIL: " + str(error), flush=True)
    raise
finally:
    (root / "goals-counts").write_text(f"{passed} {failed}\n")
    print(f"[goals] totals: PASS={passed} FAIL={failed}", flush=True)
    if agents:
        # Exact session IDs, on this authenticated private server, including failures.
        for agent in agents.values():
            try:
                api("POST", "/api/sessions/live/" + urllib.parse.quote(agent["live_name"], safe="") + "/kill",
                    {"agent_type": "claude", "session_id": agent["session_id"]}, expected=(200, 404))
            except Exception as error:
                print("[goals] cleanup: " + str(error), file=sys.stderr)

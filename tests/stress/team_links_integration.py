"""Driver for run_team_links.sh: same-computer team links (#9893) through the public API and the actual coral-board binary, as the Operator and as agents."""
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
        print("[team-links] FAIL: " + label, flush=True)
        raise AssertionError(label)
    passed += 1
    print("[team-links] PASS: " + label, flush=True)


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
               CORAL_TELEMETRY_DISABLED="1",
               CORAL_SESSION_NAME=agent["session_name"], CORAL_SUBSCRIBER_ID="Orchestrator",
               CORAL_SESSION_TOKEN=agent["token"])
    for name in ("TMUX", "TMUX_PANE", "CORAL_PORT", "CORAL_SESSION_AUTH_FILE"):
        env.pop(name, None)
    result = subprocess.run([str(root / ("coral-board" + suffix)), *map(str, args)],
                            env=env, capture_output=True, text=True, timeout=20)
    if ok:
        assert result.returncode == 0, f"CLI {' '.join(map(str, args))}: {result.stderr}"
        return result.stdout
    return result


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



def operator(*args, ok=True):
    """coral-board as the Operator: no agent identity, the private data folder's signing key."""
    env = dict(os.environ, HOME=home, USERPROFILE=home, CORAL_URL=url, CORAL_TELEMETRY_DISABLED="1")
    for name in ("TMUX", "TMUX_PANE", "CORAL_PORT", "CORAL_SESSION_AUTH_FILE", "CORAL_SESSION_TOKEN",
                 "CORAL_SESSION_NAME", "CORAL_SUBSCRIBER_ID"):
        env.pop(name, None)
    result = subprocess.run([str(root / ("coral-board" + suffix)), *map(str, args)],
                            env=env, capture_output=True, text=True, timeout=20)
    if ok:
        assert result.returncode == 0, f"operator CLI {' '.join(map(str, args))}: {result.stderr}"
        return result.stdout
    return result


def launch_team(name):
    launch = api("POST", "/api/sessions/launch-team", {
        "board_name": name, "working_dir": str(root / "work"),
        "agent_type": "claude", "backend": backend,
        "agents": [{"name": "Orchestrator", "prompt": "Mock team-links fixture"}]})
    agent = launch["agents"][0]
    assert "error" not in agent, "mock launch failed"
    live = next(s for s in api("GET", "/api/sessions/live") if s["session_id"] == agent["session_id"])
    agent["live_name"] = live["name"]
    dump = root / "env-dump" / (agent["session_id"] + ".env")
    ready(dump)
    values = dict(line.split("=", 1) for line in dump.read_text().splitlines() if "=" in line)
    assert values.get("CORAL_SESSION_TOKEN"), "mock agent received no token"
    agents[name] = dict(agent, token=values["CORAL_SESSION_TOKEN"], board=launch["board"])
    return launch["board"]


def may_send(sender, target):
    """Whether the sender team's Orchestrator can message the target team (coral-board send, the real door)."""
    result = cli(sender, "send", "--board", boards[target], "links fixture ping", ok=False)
    return result.returncode == 0, result.stdout + result.stderr


boards = {}
try:
    check("mock CLI configured", api("PUT", "/api/settings", {
        "cli_path_claude": str(root / ("mock-agent" + suffix))})["ok"])
    for name in ("links-a", "links-b", "links-c"):
        boards[name] = launch_team(name)
    check("three teams with one Orchestrator each", len(agents) == 3)
    for name, key in boards.items():  # the owner's explicit on: the same-computer door needs it (#5916)
        api("PUT", f"/api/board/{key}/settings", {"subscriber_id": "Operator", "cross_team_messaging": True})

    # nothing enforced: teams of one computer that both turned messaging on still reach each other
    sent, why = may_send("links-a", "links-b")
    check("not enforced: a message goes without a link", sent)

    # a link is recorded, and says it is not required yet
    out = operator("link", boards["links-a"], boards["links-b"])
    check("link says both ways, files on, and that it is not required yet",
          "each may message the other (files on)" in out and "not required yet" in out)
    listed = operator("links", boards["links-a"])
    check("links shows both directions", listed.count("(files on)") == 2 and "not required yet" in listed)

    # turn the list on: the link decides
    api("PUT", "/api/settings", {"cross_team_allowlist": True})
    check("enforced: a linked pair, a to b", may_send("links-a", "links-b")[0])
    check("enforced: a linked pair, b to a (both ways)", may_send("links-b", "links-a")[0])
    sent, why = may_send("links-a", "links-c")
    check("enforced: an unlinked pair is refused", not sent and "does not take messages" in why)

    # one way: unlink only a-messaging-b; b still reaches a
    operator("unlink", boards["links-a"], boards["links-b"], "--one-way")
    check("one-way unlink: a no longer reaches b", not may_send("links-a", "links-b")[0])
    check("one-way unlink: b still reaches a", may_send("links-b", "links-a")[0])

    # a one-way link with files off
    out = operator("link", boards["links-a"], boards["links-c"], "--one-way", "--no-files")
    check("link --one-way --no-files says so", "one way, files off" in out)
    check("a reaches c through its link", may_send("links-a", "links-c")[0])
    check("c does not reach a (one way)", not may_send("links-c", "links-a")[0])
    listed = operator("links", boards["links-c"])
    check("links shows files off for the one-way link", "(files off)" in listed)

    # no agent, an Orchestrator included, makes or reads a link
    for args in (("link", boards["links-a"], boards["links-c"]), ("unlink", boards["links-a"], boards["links-c"]), ("links", boards["links-a"])):
        result = cli("links-a", *args, ok=False)
        check(f"an Orchestrator's {args[0]} is refused (403 forbidden_for_agent)", result.returncode != 0 and "forbidden_for_agent" in (result.stderr + result.stdout))

    # unlink both: the pair is cut and the server says it still works
    operator("unlink", boards["links-b"], boards["links-a"])
    check("unlink both: b and a are cut", not may_send("links-b", "links-a")[0] and not may_send("links-a", "links-b")[0])

    # a burst of links and unlinks keeps one coherent list (the edit rate limit is per hour, so stay under it)
    for _ in range(6):
        operator("link", boards["links-b"], boards["links-c"])
        operator("unlink", boards["links-b"], boards["links-c"])
    operator("link", boards["links-b"], boards["links-c"])
    check("after a burst the pair is linked once", may_send("links-b", "links-c")[0] and may_send("links-c", "links-b")[0])
    listed = operator("links", boards["links-b"])
    check("and listed once each way", listed.count("links-c") == 2)
except Exception as error:
    if failed == 0:
        failed += 1
        print("[team-links] FAIL: " + str(error), flush=True)
    raise
finally:
    try:
        api("PUT", "/api/settings", {"cross_team_allowlist": False})
    except Exception as error:
        print("[team-links] cleanup: " + str(error), file=sys.stderr)
    (root / "links-counts").write_text(f"{passed} {failed}\n")
    print(f"[team-links] totals: PASS={passed} FAIL={failed}", flush=True)
    for agent in agents.values():
        try:
            api("POST", "/api/sessions/live/" + urllib.parse.quote(agent["live_name"], safe="") + "/kill",
                {"agent_type": "claude", "session_id": agent["session_id"]}, expected=(200, 404))
        except Exception as error:
            print("[team-links] cleanup: " + str(error), file=sys.stderr)

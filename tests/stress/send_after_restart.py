"""Driver for run_send_after_restart.sh (Goal #133, #10996): a person's send through the composer's route after Coral restarts.

Two phases, with the shell restarting the server between them (the agents' terminals survive it):
  before  launch a team of two mock agents, send once to each, save who they are
  after   Coral is a new process: send to each as the dashboard's composer does, sleep and wake one and send again,
          and send while a board nudge is due. Every send must come back 200 and land in the agent's terminal:
          no `session target mismatch` (#10813) and no `not_submitted`.

The composer's request is POST /api/sessions/live/<name>/send {command, agent_type, session_id}, the name and type being the
ones the live list gives (pkg/frontend/static/controls.js). It is sent to the server directly, the handler the Hub's tunnel
reaches (the tunnel adds only its via-header, which cloud_routes_test.go covers); no Hub is started here.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

phase, url, folder, suffix, backend, home, tag = sys.argv[1:8]
root = Path(folder)
state_file = root / f"send-restart-{tag}.json"
cookie = ""
for line in (root / "cookies.txt").read_text().splitlines():
    line = line.removeprefix("#HttpOnly_")
    fields = line.split("\t")
    if len(fields) == 7 and not line.startswith("#") and fields[5].startswith("coral_session"):
        cookie += ("; " if cookie else "") + fields[5] + "=" + fields[6]
assert cookie, "private login did not create a cookie"
passed = 0


def check(label, condition, detail=""):
    global passed
    if not condition:
        print(f"[send-restart] FAIL: {label} {detail}", flush=True)
        raise AssertionError(label + " " + str(detail))
    passed += 1
    print(f"[send-restart] PASS: {label}", flush=True)


def call(method, path, body=None):
    req = urllib.request.Request(
        url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": url, "Sec-Fetch-Site": "same-origin"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw.decode(errors="replace")}


def api(method, path, body=None):
    code, value = call(method, path, body)
    assert code == 200, f"{method} {path}: HTTP {code}: {value}"
    return value


def row(session_id):
    found = [s for s in api("GET", "/api/sessions/live") if s["session_id"] == session_id]
    assert len(found) == 1, f"live list has {len(found)} rows for {session_id}"
    return found[0]


def composer_send(session_id, text):
    """The request the composer makes: the name and type its list row holds."""
    s = row(session_id)
    return call("POST", "/api/sessions/live/" + urllib.parse.quote(s["name"], safe="") + "/send",
                {"command": text, "agent_type": s["agent_type"], "session_id": session_id})


def terminal(session_id):
    # What the mock agent's terminal delivered: the raw-input log it keeps (MOCK_AGENT_RAW_DIR), one file per session.
    raw = root / "raw" / (session_id + ".raw")
    return raw.read_bytes().decode("utf-8", "replace").replace("\n", "").replace("\r", "") if raw.is_file() else ""


def landed(session_id, text, seconds=60):
    # A bounded wait on what the agent received, not a fixed delay.
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if text in terminal(session_id):
            return True
        time.sleep(0.25)
    return False


def delivered(label, session_id, text):
    end = time.monotonic() + 45
    while True:
        code, value = composer_send(session_id, text)
        # "Not ready yet, your message was not sent" is the server's honest answer to a send in the first moments of an agent
        # (after a restart or a wake): the composer keeps the text and the person sends again. Only that is retried.
        if not (code == 200 and value.get("code") == "agent_not_ready" and time.monotonic() < end):
            break
        time.sleep(0.5)
    refusal = json.dumps(value)
    check(f"{label}: HTTP 200", code == 200, refusal)
    check(f"{label}: no session target mismatch", "session target mismatch" not in refusal
          and value.get("code") != "session_target_mismatch", refusal)
    check(f"{label}: no not_submitted", "not_submitted" not in refusal and not value.get("error"), refusal)
    check(f"{label}: the text reached the agent's terminal", landed(session_id, text))


def board_cli(who, *args):
    s = state["agents"][who]
    env = dict(os.environ, HOME=home, USERPROFILE=home, CORAL_URL=url, CORAL_TELEMETRY_DISABLED="1",
               CORAL_SESSION_NAME=s["session_name"], CORAL_SUBSCRIBER_ID=who, CORAL_SESSION_TOKEN=s["token"])
    for name in ("TMUX", "TMUX_PANE", "CORAL_PORT", "CORAL_SESSION_AUTH_FILE"):
        env.pop(name, None)
    result = subprocess.run([str(root / ("coral-board" + suffix)), *args], env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, f"coral-board {args}: {result.stderr}"
    return result.stdout


def mock_ready(session_id):
    dump = root / "env-dump" / (session_id + ".env")
    raw = root / "raw" / (session_id + ".raw")
    end = time.monotonic() + 30
    while time.monotonic() < end and not (dump.is_file() and raw.is_file()):
        time.sleep(0.2)
    assert dump.is_file() and raw.is_file(), "mock agent did not become ready"
    return dict(line.split("=", 1) for line in dump.read_text().splitlines() if "=" in line)


state = {}
try:
    if phase == "before":
        assert api("PUT", "/api/settings", {"cli_path_claude": str(root / ("mock-agent" + suffix))})["ok"]
        launch = api("POST", "/api/sessions/launch-team", {
            "board_name": "send-restart-" + tag, "working_dir": str(root / "work"), "agent_type": "claude",
            "backend": backend, "agents": [{"name": n, "prompt": "Mock send-after-restart fixture"} for n in ("Sender", "Peer")]})
        state = {"board": launch["board"], "agents": {}}
        for agent in launch["agents"]:
            assert "error" not in agent, "mock launch failed"
            values = mock_ready(agent["session_id"])
            state["agents"][agent["name"]] = {"session_id": agent["session_id"], "session_name": values.get("CORAL_SESSION_NAME", agent["name"]),
                                              "token": values["CORAL_SESSION_TOKEN"]}
        for who, s in state["agents"].items():
            delivered(f"before the restart, a send to {who}", s["session_id"], f"before-restart {who} {tag}")
        state_file.write_text(json.dumps(state))
    else:
        state = json.loads(state_file.read_text())
        sender, peer = state["agents"]["Sender"], state["agents"]["Peer"]
        for who, s in state["agents"].items():
            check(f"after the restart, {who} is still a live row", row(s["session_id"])["session_id"] == s["session_id"])
            delivered(f"after the restart, a send to {who}", s["session_id"], f"after-restart {who} {tag}")
        # Sleep and wake: the row is the same session, and its next send is not refused for a name or type that changed.
        check("the sender goes to sleep", api("POST", f"/api/sessions/live/{sender['session_id']}/sleep", {})["sleeping"])
        api("POST", f"/api/sessions/live/{sender['session_id']}/wake", {})
        mock_ready(sender["session_id"])
        delivered("after a restart and a wake, a send to Sender", sender["session_id"], f"after-wake Sender {tag}")
        # A board nudge is due (#10996): a message for Sender from Peer, then a person's send at once, three times over.
        for i in range(3):
            board_cli("Peer", "post", f"@Sender nudge {i} {tag}")
            delivered(f"a send while a board nudge is due, round {i}", sender["session_id"], f"while-nudged {i} {tag}")
        check("Peer's terminal was never typed into by Sender's sends", f"while-nudged 0 {tag}" not in terminal(peer["session_id"]))
finally:
    print(f"[send-restart] {phase}: PASS={passed}", flush=True)

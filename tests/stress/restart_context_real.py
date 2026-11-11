#!/usr/bin/env python3
"""Restart must clear an agent's context and send its initial prompt again (#15464), proved on REAL agents.

For each path (plain Restart, Restart with changes, a sleeping agent's Restart) and each CLI (claude, codex): tell the agent a codename, restart it, ask for the codename.
Pass = a NEW session, the new transcript's first user turn is the full initial prompt (the launch prompt, the skills note, the board text), the codename is nowhere in the new
transcript and the agent answers UNKNOWN. Not a CI test: it spends real model calls. Run it by hand on a changed Restart.

Usage:  CORAL_BIN_DIR=<dir with coral (-tags "dev fts5"), coral-board, coral-agent, coral-hook-*> CORAL_PROOF_DIR=<a folder under a folder the CLI already trusts>
        [CORAL_TEST_BACKEND=pty|tmux] [CODEX_HOME=<scratch copy of auth.json + config.toml>] python3 tests/stress/restart_context_real.py claude [codex]
Safety: its own CORAL_DATA_DIR (a SHORT path: a tmux socket path over ~100 characters fails), --cloud-url off, --no-browser, telemetry off, port 18456 (never 8420), the server and its
agents stopped by PID/own socket. It uses the real HOME (the CLI's login lives there) and never accepts a folder trust: the proof folder must already be trusted. For Codex, point CODEX_HOME at a scratch
copy so the hook review and the rate-limit notice are answered in the copy, not in the Operator's own ~/.codex. Claude's own auto-memory persists across a restart (Coral does not clear it), so the
codename is told with "never write it to any file or memory".
"""
import glob, json, os, signal, subprocess, sys, tempfile, time, urllib.request, urllib.error

BIN = os.environ['CORAL_BIN_DIR']; WORK = os.environ['CORAL_PROOF_DIR']; PORT = 18456; BASE = f'http://127.0.0.1:{PORT}'
BACKEND = os.environ.get('CORAL_TEST_BACKEND', 'tmux'); DATA = tempfile.mkdtemp(prefix='c15464-', dir='/tmp')
if PORT == 8420: sys.exit('refusing the production port')
def env():
    e = {k: v for k, v in os.environ.items() if not k.startswith('CORAL_') and k not in ('TMUX', 'TMUX_PANE')}
    e.update({'CORAL_DATA_DIR': DATA, 'CORAL_TELEMETRY_DISABLED': '1', 'CORAL_NO_DEMO_SEED': '1', 'CORAL_NO_WELCOME': '1', 'CORAL_TMUX_NO_FALLBACK': '1', 'CORAL_HOOK_DIR': BIN}); return e
def api(m, p, body=None):
    key = open(DATA + '/api_key').read().strip()
    req = urllib.request.Request(BASE + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=60) as f: return json.loads(f.read() or b'null')
    except urllib.error.HTTPError as e: return {'http_error': e.code, 'body': e.read().decode()[:300]}
def rows(kind): d = api('GET', '/api/sessions/live'); d = d if isinstance(d, list) else d.get('sessions', []); return [x for x in d if x['agent_type'] == kind]
def start():
    os.makedirs(WORK, exist_ok=True)
    p = subprocess.Popen([BIN + '/coral', '--home', DATA, '--no-browser', '--cloud-url', 'off', '--host', '127.0.0.1', '--port', str(PORT), '--backend', BACKEND], env=env(), stdout=open(DATA + '/server.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(90):
        time.sleep(0.5)
        if os.path.exists(DATA + '/api_key'):
            try: api('GET', '/api/sessions/live'); return p
            except Exception: pass
    p.kill(); sys.exit('the server did not come up')
def stop(p):
    subprocess.run(['tmux', '-S', DATA + '/tmux.sock', 'kill-server'], capture_output=True)  # our own socket only
    for pid in subprocess.run(['pgrep', '-P', str(p.pid)], capture_output=True, text=True).stdout.split(): 
        try: os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError: pass
    p.terminate()
def claude_turns(sid):
    out = []
    for f in glob.glob(os.path.expanduser('~/.claude/projects/*/' + sid + '.jsonl')):
        for l in open(f):
            j = json.loads(l); m = j.get('message') or {}; c = m.get('content')
            if isinstance(c, list): c = ' '.join(x.get('text', '') for x in c if isinstance(x, dict))
            if j.get('type') in ('user', 'assistant') and isinstance(c, str) and c.strip(): out.append((j['type'], c))
    return out, (glob.glob(os.path.expanduser('~/.claude/projects/*/' + sid + '.jsonl')) or [None])[0]
def codex_turns(_sid):  # a Codex rollout carries its own id, so the newest rollout is the live agent's
    home = os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
    fs = sorted(glob.glob(home + '/sessions/**/*.jsonl', recursive=True), key=os.path.getmtime); out = []
    for l in open(fs[-1]):
        j = json.loads(l); p = j.get('payload') or {}
        if j.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') in ('user', 'assistant'):
            out.append((p['role'], ' '.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))))
    return out, fs[-1]
def turns(kind, sid): return (claude_turns if kind == 'claude' else codex_turns)(sid)
def screen(row): return api('GET', f'/api/sessions/live/{row["name"]}/capture?session_id={row["session_id"]}&agent_type={row["agent_type"]}').get('capture', '')
def clear(row):  # a Codex hook review or rate-limit notice (answered in CODEX_HOME's copy) blocks input until answered
    for _ in range(4):
        c = screen(row); ans = None
        if 'Approaching rate limits' in c: ans = (2, 'Keep current model')
        elif 'Hooks need review' in c: ans = (2, 'Trust all and continue')
        if not ans: return
        api('POST', f'/api/sessions/live/{row["name"]}/answer-prompt', {'session_id': row['session_id'], 'agent_type': row['agent_type'], 'n': ans[0], 'label': ans[1]}); time.sleep(8)
def send(row, text):
    clear(row); o = api('POST', f'/api/sessions/live/{row["name"]}/send', {'command': text, 'agent_type': row['agent_type'], 'session_id': row['session_id']})
    if o.get('skipped'): sys.exit(f'nothing was typed ({o}): a prompt is open')
def launch(kind):
    out = api('POST', '/api/sessions/launch-team', {'board_name': 'restart-proof-' + kind, 'working_dir': WORK, 'agent_type': kind, 'backend': BACKEND,
        'agents': [{'name': 'Orchestrator', 'role': 'orchestrator', 'agent_type': kind, 'prompt': 'You are the proof agent. When you have read your instructions, reply with one line: READY.'}]})
    if not out.get('ok'): sys.exit(f'launch failed: {out}')
    time.sleep(40); clear(rows(kind)[0]); time.sleep(15)
def run(kind, mode, word):
    row = rows(kind)[0]; old = row['session_id']
    send(row, f"For this conversation only, my codename is {word}. Never write it to any file or memory, and use no tools. Reply with one line: NOTED."); time.sleep(28)
    t, _ = turns(kind, old); assert t[-1][1].strip().startswith('NOTED'), 'the agent did not note the codename'
    body = {'agent_type': kind, 'session_id': old}
    if mode == 'sleep':
        api('POST', f'/api/sessions/live/{old}/sleep', {}); time.sleep(8); assert rows(kind)[0].get('sleeping'), 'it did not fall asleep'
    if mode == 'changes':  # as the dialog sends it: the prompt it was prefilled with (the launch prompt and the skills note), here with a model change for Claude
        first = [x for r_, x in turns(kind, old)[0] if r_ == 'user' and 'You are the proof agent' in x][0].split('\n\nIMPORTANT: You were automatically joined')[0]; body['prompt'] = first
        if kind == 'claude': body['model'] = 'sonnet'
    new = api('POST', f'/api/sessions/live/{rows(kind)[0]["name"]}/restart', body)['session_id']; time.sleep(40)
    row = rows(kind)[0]; clear(row); time.sleep(3)
    send(row, "What is my codename? If you do not know it, reply exactly: UNKNOWN. Use no tools."); time.sleep(30)
    t, f = turns(kind, new); first = [x for r_, x in t if r_ == 'user' and 'You are the proof agent' in x][0]; ans = [x for r_, x in t if r_ == 'assistant'][-1].strip()
    leaked = open(f).read().count(word)
    ok = new != old and ans == 'UNKNOWN' and leaked == 0 and 'Skills the Operator approved' in first and 'coral-board' in first
    print(f'{"PASS" if ok else "FAIL"} {kind}/{mode}/{BACKEND}: new session {new[:8]} (was {old[:8]}); first turn {len(first)} chars, skills note and board text in it: {"Skills the Operator approved" in first and "coral-board" in first}; the codename is in the new transcript {leaked} times; the agent answered {ans[:20]!r}')
    return ok
if __name__ == '__main__':
    kinds = sys.argv[1:] or ['claude']; srv = start(); ok = True
    try:
        for kind in kinds:
            launch(kind)
            for mode, word in (('plain', 'HERON-4402'), ('changes', 'OSPREY-5519'), ('sleep', 'LYNX-1209')): ok = run(kind, mode, word) and ok
            for r_ in rows(kind): api('POST', f'/api/sessions/live/{r_["name"]}/kill', {'session_id': r_['session_id'], 'agent_type': kind})
    finally: stop(srv)
    sys.exit(0 if ok else 1)

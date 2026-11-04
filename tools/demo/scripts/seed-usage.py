#!/usr/bin/env python3
"""Invented usage history for the demo Coral's own database, so the Analytics charts have a shape.

usage: DEMO_ROOT=... seed-usage.py [days]    (after rig-up.sh and the team launch; the mock agents' own rows stay)

It writes only to $DEMO_ROOT/data/sessions.db, refuses a folder without the .coral-demo-root marker, and the numbers are made up:
a few rows a day per agent for the last 7 days, three model names, costs from tokens at round per-million prices.
"""
import os, random, sqlite3, sys
from datetime import datetime, timedelta, timezone

root = os.environ.get("DEMO_ROOT", "")
if not root or root in ("/", os.path.expanduser("~")) or not os.path.exists(os.path.join(root, ".coral-demo-root")):
    sys.exit("DEMO_ROOT must be a folder with a .coral-demo-root marker")
db = os.path.join(root, "data", "sessions.db")
days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
rng = random.Random(214)   # the same made-up history every run
# model: (share of an agent's rows, $ per million input, $ per million output)
MODELS = {"claude-opus-5-5": (15.0, 75.0), "claude-sonnet-5-5": (3.0, 15.0), "claude-haiku-5-5": (0.8, 4.0)}
WEIGHT = {"Orchestrator": ["claude-opus-5-5"] * 3 + ["claude-sonnet-5-5"], "Backend": ["claude-sonnet-5-5"] * 3 + ["claude-opus-5-5"],
          "Frontend": ["claude-sonnet-5-5"] * 3 + ["claude-haiku-5-5"], "Designer": ["claude-sonnet-5-5", "claude-haiku-5-5"], "Reviewer": ["claude-haiku-5-5"] * 2 + ["claude-sonnet-5-5"]}
con = sqlite3.connect(db, timeout=30)
con.execute("PRAGMA busy_timeout=30000")
agents = con.execute("SELECT DISTINCT session_id, agent_name, team_id, board_name FROM token_usage WHERE agent_name IN (%s)" % ",".join("?" * len(WEIGHT)), list(WEIGHT)).fetchall()
if not agents:
    sys.exit("no demo agents have usage rows yet: launch the team and let each agent answer once, then run this")
now = datetime.now(timezone.utc).replace(microsecond=0)
n = 0
for d in range(days, 0, -1):
    ramp = 0.5 + 0.5 * (days - d) / days   # busier towards today
    for sid, name, team, board in agents:
        for _ in range(rng.randint(2, 5)):
            at = now - timedelta(days=d, hours=rng.randint(0, 9), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
            model = rng.choice(WEIGHT[name])
            inp = int(rng.uniform(8e3, 90e3) * ramp); out = int(rng.uniform(1.5e3, 14e3) * ramp)
            cr = int(rng.uniform(2e4, 3e5) * ramp); cw = int(rng.uniform(0, 3e4))
            pin, pout = MODELS[model]
            cost = inp / 1e6 * pin + out / 1e6 * pout + cr / 1e6 * pin * 0.1 + cw / 1e6 * pin * 1.25
            ts = at.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            con.execute("INSERT OR IGNORE INTO token_usage(session_id,agent_name,agent_type,team_id,board_name,input_tokens,output_tokens,total_tokens,cost_usd,num_turns,recorded_at,cache_read_tokens,cache_write_tokens,session_start_at,last_activity_at,source,model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (sid, name, "claude", team, board, inp, out, inp + out + cr + cw, round(cost, 4), rng.randint(3, 20), ts, cr, cw, ts, ts, "jsonl", model))
            n += 1
con.commit()
tot = con.execute("SELECT COUNT(*), ROUND(SUM(cost_usd),2) FROM token_usage").fetchone()
print(f"seeded {n} invented usage rows over {days} days; token_usage now has {tot[0]} rows, ${tot[1]} in all")

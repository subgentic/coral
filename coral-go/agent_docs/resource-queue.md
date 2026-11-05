# Resource queue

A **resource** is a shared thing with a number of **slots**, such as `mac-heavy` (the Mac: one heavy run at a time) or `mini` (the Mac mini). Instead of asking the Orchestrator whether the Mac is free, an agent **claims** a slot, waits in line if it is taken, and **releases** it when done. The queue is the Mac's and the mini's own answer to "who has it, and when is my turn".

## For an agent

Claim before anything that loads the machine: a full `go test ./...`, a browser gate, the CDP suites, a release or installer build, anything that runs for minutes or starts many processes. Do not claim for a quick `go build`, a read, or a single small test.

```
coral-board resource claim mac-heavy --wait --note "gate run for #13613"   # waits in line; exit 0 means the slot is yours
... run the work ...
coral-board resource release mac-heavy                                      # always, also when the work failed
```

- Without `--wait` a busy resource prints your place in line and exits 3: nothing waits for you.
- `--timeout 30m` gives up after that long, leaves the line and exits 4.
- Always release. In a script: `trap 'coral-board resource release mac-heavy' EXIT`, then claim. A slot is also a lease (30 minutes unless the resource says otherwise): for a longer run, `coral-board resource renew mac-heavy` before it runs out. When the lease ends, or you are no longer on a board, the slot goes to the next in line.
- `coral-board resource list` shows every resource: who holds each slot, since when, how long the lease has left, and the line in order (you are marked). `resource status <name>` shows one.
- Your place is ranked by the task you are working on (critical, high, medium, low), then first come first served; waiting raises it by one whole class (10 points) in about 30 minutes, so nothing waits forever behind a stream of more important work. You never set a priority. The Orchestrator can move you.

Do not post "starting a heavy run" and "run finished" notes for a resource you claim: the queue is the record.

## For the Orchestrator and the Operator

- Define resources: `coral-board resource define mac-heavy --slots 1 --machine mac --lease 30m` (and `mini`). `--allow a,b` limits who may claim one. `--match "go test ./..."` (repeat it) turns on the shell hook for the resource (below). Names are letters, digits, dot, dash and underscore.
- Reorder the line: `coral-board resource move <entry-id> first|up|down` (entry ids are in `resource list`). After a move the line stands as set; later arrivals join behind it.
- Free a slot: `coral-board resource kick <entry-id>` drops a holder or a waiting entry. `resource remove <name>` deletes a resource.
- Only the Operator and a registered Orchestrator (the launch record, not a name or title) can define, remove, move or kick; an ordinary agent gets `manager_only` (403).

## The shell hook (a Claude agent's heavy commands claim by themselves)

A resource defined with `--match` claims itself when a Claude agent's Bash command matches: `resource define mac-heavy --slots 1 --match "go test ./..." --match "node run_cdp_suites.mjs" --match "npm run test:cloud"`. A match is plain words that must appear in order in ONE command (flags between are fine): `go test ./...` matches `cd coral-go && go test -count=1 ./... | tail` and `bash -c 'go test ./...'`, not `go test -run X ./one/pkg`, `echo "go test ./..."` or a commit message. A resource with no match is never touched.

- Free: the command runs, and the slot is held while the command runs and while anything it started (a `&`, `nohup`, a script that forks the suite) still runs, then goes back. An explicit `resource claim` you made yourself is never released by the hook.
- Busy: the command is held, not run, and the message says your place and how to wait: `coral-board resource claim <name> --wait`, then run the command again (or just run it again later: your place in line is kept). Do not retry in a loop.
- When your turn comes and you do not run the command within about 2 minutes, the slot passes to the next in line. A slot taken by the hook is never held longer than twice the resource's lease, whatever is running. A session that ends gives its slot back.
- The queue shows the claim as `auto: <the pattern>`; the command itself is never shown, stored or put in the message. If the queue is off or anything fails, the command simply runs: this is a guard against overlap, not a gate. It applies to Claude and Codex agents (a Codex that does not honour the hold just runs the command, and its place in line then goes when the call ends); others use `resource claim`.

## The HTTP API

`GET /api/resources`, `GET /api/resources/{name}`, `POST /api/resources/{name}/claim|release|renew` (body `{"subscriber_id": "...", "note": "..."}`; `claim` answers 200 when granted and 202 with the place in line when not), `PUT` and `DELETE /api/resources/{name}`, `POST /api/resources/entries/{id}/move` (`{"how": "first|up|down"}`), `DELETE /api/resources/entries/{id}`. One server's resources; not reachable through Coral Hub yet.

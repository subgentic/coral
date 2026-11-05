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

- Define resources: `coral-board resource define mac-heavy --slots 1 --machine mac --lease 30m` (and `mini`). `--allow a,b` limits who may claim one. Names are letters, digits, dot, dash and underscore.
- Reorder the line: `coral-board resource move <entry-id> first|up|down` (entry ids are in `resource list`). After a move the line stands as set; later arrivals join behind it.
- Free a slot: `coral-board resource kick <entry-id>` drops a holder or a waiting entry. `resource remove <name>` deletes a resource.
- Only the Operator and a registered Orchestrator (the launch record, not a name or title) can define, remove, move or kick; an ordinary agent gets `manager_only` (403).

## The HTTP API

`GET /api/resources`, `GET /api/resources/{name}`, `POST /api/resources/{name}/claim|release|renew` (body `{"subscriber_id": "...", "note": "..."}`; `claim` answers 200 when granted and 202 with the place in line when not), `PUT` and `DELETE /api/resources/{name}`, `POST /api/resources/entries/{id}/move` (`{"how": "first|up|down"}`), `DELETE /api/resources/entries/{id}`. One server's resources; not reachable through Coral Hub yet.

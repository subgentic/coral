# The loopback-only Codex profile is parked (#7489)

Status: built, tested, **off by default, not landed**. Decision (Orchestrator, 2026-10-25): park it. The operator can reopen it.

## What it is
A Codex 0.163 permission profile (`coralonly`, extends `:workspace`, network limited, `127.0.0.1` allowed through Codex's command proxy, `features.network_proxy`) selected with `-c default_permissions="coralonly" -a never` (no legacy `--sandbox`: it makes Codex drop the profile), replacing the broad `sandbox_workspace_write.network_access=true` of #7483. `internal/coralproxy` sends a loopback request through the proxy when `CODEX_NETWORK_PROXY_ACTIVE` is set and the proxy named by `HTTP_PROXY` is a loopback IP. `CORAL_CODEX_LOOPBACK_PROFILE=1` turns the launch side on.

## Measured by Codex Test on real Codex 0.163 (#7488, #7498, #7489)
- The profile loads from the inline `-c` form and is active in the interactive CLI; a command reaches `127.0.0.1` (HTTP 200/307) and gets 403 for any other host; direct connections are blocked.
- Plain HTTP goes through the proxy as an absolute-form request, no CONNECT; `NO_PROXY` does not list loopback.
- Host hooks (outside the sandbox) deliver normally.
- **A worker's `coral-board post`, `read` and `coral-agent` upload all exit 5**: "token withheld: the local service did not prove its identity", naming the proxy's port.

## Why it is parked
`internal/serverproof` proves the server before the token is sent on a new connection: it sends a challenge on that connection and checks a proof over (key, port, nonce, the client endpoint, the server endpoint) of that connection (`client.go`, `Prove`). Through a proxy the client's connection is to the proxy, and Coral sees the proxy's own connection with other endpoints, so the proof can never match. The endpoint binding is the point: it stops a program that holds Coral's port from relaying the challenge to the real Coral and then receiving the token (#6103). The profile also allows all of `127.0.0.1` (every local service), so its gain over the broad switch is the outbound internet only.

## What would be needed to pick it up
- (a) send the token through the proxy with no proof: simple, drops the squatter protection on that path. Not recommended.
- (b) a proxied proof mode: the client asks for a proof bound to (key, port, nonce) only, with a flag the server honours only when the request arrives from the Codex proxy; needs a server change, a Security design (a squatter could relay to a real Coral running on another port) and tests for the relay case; the client side is then a second proof path in `serverproof.NewTransport` used when `coralproxy.Func` chose the proxy.
- In both: real-Codex checks of POST through the profile's `limited` mode, `coral-board wait` (a 65 s poll) and artifact upload/download, the same file boundary as `--sandbox workspace-write`, and a malformed profile refusing to start.

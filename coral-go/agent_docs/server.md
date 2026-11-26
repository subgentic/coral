# Run Coral on a server

> Install Coral headless on a Linux server with a service user, a systemd unit, a dashboard password and remote access.

This page covers a headless Linux server (such as an Ubuntu VPS) where no desktop or browser runs on the machine itself. Everything runs as a dedicated service user, listens on loopback (`127.0.0.1:8420`), and is reached through **Coral Hub**, an **SSH or Tailscale tunnel**, or a **same-computer TLS reverse proxy** with a dashboard password set first.

## 1. Create a service user (do not run as root)

Coral does not sandbox agents: an agent can run any command and read or write any file that Coral's OS user can ([auth.md](auth.md#what-it-does-not-defend)). Never run Coral as `root`. If you started Coral as `root` once, do not reuse that `/root/.coral` folder — start fresh under a dedicated account without `sudo`:

```bash
sudo useradd --system --create-home --home-dir /home/coral --shell /bin/bash coral
```

By default Coral keeps all of its state in `~/.coral` (`/home/coral/.coral` for the `coral` user), created with mode `0700` and `0600` files: `sessions.db`, `messageboard.db`, `api_key`, `password`, `cli-token`, `session_tokens/`, `logs/`, `artifacts/` and `uploads/`. Override the folder with `--home <dir>` or `CORAL_DATA_DIR=<dir>`. See [What Coral stores on this computer](what-coral-stores.md).

## 2. Install Coral and an agent CLI

### Install Coral

Run the official installer as the `coral` user (it downloads the release tarball for `x86_64` or `aarch64`, checks `SHA256SUMS.txt`, and puts `coral`, `coral-board`, `coral-agent`, `launch-coral`, `coral-update` and the `coral-hook-*` binaries into `/home/coral/.local/bin`):

```bash
sudo -u coral -i bash -c 'curl -fsSL https://github.com/subgentic/coral/releases/latest/download/install.sh | bash'
```

Or install the binaries system-wide into `/usr/local/bin` as root after verifying the tarball against `SHA256SUMS.txt`:

```bash
# Replace amd64 with arm64 on aarch64
curl -fsSLO https://github.com/subgentic/coral/releases/latest/download/coral-linux-amd64.tar.gz
curl -fsSLO https://github.com/subgentic/coral/releases/latest/download/SHA256SUMS.txt
grep " coral-linux-amd64.tar.gz$" SHA256SUMS.txt | sha256sum -c -

d="$(mktemp -d)"
tar -xzf coral-linux-amd64.tar.gz -C "$d" --no-same-owner
for prog in coral launch-coral coral-board coral-agent coral-hook-agentic-state coral-hook-message-check coral-hook-session-start coral-hook-task-sync coral-update; do
  sudo install -m 0755 -o root -g root "$d/$prog" "/usr/local/bin/$prog"
done
rm -rf "$d"
```

### Install an agent CLI where the service user finds it

Coral drives the coding agent CLIs installed on the server (`claude`, `codex`, `agy`, `pi`); it does not install or sign in to them for you.

- **How Coral finds a CLI on Linux:** When checking or launching an agent, Coral looks in:
  1. The custom path set in **Settings > Providers** (`cli_path_claude`, `cli_path_codex`, `cli_path_agy`, `cli_path_pi` via `PUT /api/settings`).
  2. The `PATH` of the `coral` server process (`exec.LookPath`). On Linux, Coral keeps the exact `PATH` systemd gives it (the login-shell `PATH` widening in `internal/loginpath` runs on macOS only).
  3. Fixed common install locations for the service user: `/usr/local/bin/<binary>`, `/home/coral/.local/bin/<binary>`, `/snap/bin/<binary>`, `/home/coral/.nvm/versions/node/*/bin/<binary>`, and `/home/coral/.claude/local/claude`.
- **Node.js for npm-installed CLIs (`claude`, `codex`, `pi`):** These CLIs start with `#!/usr/bin/env node`. Keep `node`'s directory (such as `/usr/bin` or `/usr/local/bin`) on `PATH` in the systemd unit, or beside the CLI binary in a directory that is not writable by other users.
- **Does Coral need a restart after you install a CLI?** **No.** Coral checks `PATH` and the common install locations on every `GET /api/system/cli-check` call and on every agent launch (`FindCLI` / `LaunchCLI`). You only need to restart the service if you installed the CLI into a custom directory that was not already on the systemd unit's `Environment=PATH=...` (and is not one of the common locations above) and you are not setting `cli_path_<type>` in Settings.

### Confirm that Coral sees the agent CLI

There is **no `coral` CLI subcommand** (such as `coral cli-check`) to probe agent CLIs from the shell. Confirm in either of two ways:

1. **In the dashboard:** Open **New agent** (or **Settings > Providers**); Coral checks each provider and shows whether its CLI was found and its version.
2. **Over the API on the server** (as the `coral` service user, once Coral is running):

   ```bash
   sudo -u coral -i bash -c 'curl -s -H "Authorization: Bearer $(coral api-key)" "http://127.0.0.1:8420/api/system/cli-check?type=claude"'
   ```

   When found, it returns `{"agent_type":"claude","found":true,"path":"/usr/local/bin/claude","probe":"ok","status":"available","version":"..."}` (add `&signin=1` to check whether `claude` or `codex` is signed in: `"signed_in":true|false`). See [CLI Check](settings-system.md#cli-check).

### Sign in to the agent CLI as the service user

> **Security warning — provider credentials live on the server:** The agent CLI's provider login or API key (for example `/home/coral/.claude`, `/home/coral/.codex`, `/home/coral/.gemini`, `/home/coral/.pi`) is stored in `/home/coral` under the `coral` service account. **Sign in as the `coral` user** (for example `sudo -u coral -i claude`), never as `root`.
>
> Anyone who can sign in to the Coral dashboard (or who holds Coral's API key) can open terminals, launch agents and run commands as the `coral` user on that server — which means **your agent provider login and subscription on that server are exposed to anyone who has the Coral dashboard password**.

## 3. Accept the Terms of Service

> **[PLACEHOLDER — awaiting `#21530` (`--accept-terms` / `CORAL_ACCEPT_TERMS=1`)]:** The headless Terms of Service launch flag `--accept-terms` (and `CORAL_ACCEPT_TERMS=1`) is being added in `#21530`. The human installing Coral sets `--accept-terms` (or `CORAL_ACCEPT_TERMS=1`) after reading the Terms; an installing or deploying agent must **never** set `--accept-terms` or `CORAL_ACCEPT_TERMS=1` on a person's behalf, and must **never** fake a pseudo-terminal (`pty`) or write a helper script to accept the Terms.
>
> Until `#21530` lands:
> - **Interactive terminal once as the service user:** Run `sudo -u coral -i coral --no-browser` in an interactive SSH session (`ssh -t`), read the Terms of Service, type `accept`, and press `Ctrl+C` once the server prints the dashboard URL (this writes `/home/coral/.coral/.eula-accepted`).
> - **Coral Hub bootstrap credential:** When a machine starts with a one-time Coral Hub bootstrap credential (`--bootstrap-file` or `/run/coral/bootstrap.d/credential`), Coral records the Terms acceptance confirmed by Coral Hub on enrollment ([hub.md](hub.md#enrolling-with-a-one-time-credential-cloud-hub)).

## 4. Set the dashboard password headlessly

> **A Coral sign-in is shell access to the server:** Signing in to Coral gives full control of the `coral` account's terminals, files and signed-in agent CLIs on that machine. Coral has **no built-in 2FA or passkeys** on its local password sign-in. If the server is reachable over a network, use a **long, high-entropy password** over HTTPS (or keep Coral off the public internet behind Coral Hub, Tailscale or an SSH tunnel).
>
> **Password length rules in code (`internal/auth/password.go`):** Coral accepts any non-empty password from **1 byte up to 4,096 bytes** (after NFKC normalization; stored as an argon2id hash in `<data dir>/password`, mode `0600`). The code does **not** enforce a minimum length above 1 byte (the dashboard's strength meter only advises), so you must enforce a strong password policy yourself.

Never pass a password on the command line, in a `bash -c '...'` argument, or in an environment variable (`ps`, `/proc/<pid>/environ` and shell history expose them). Read the password silently with `read -rs PW` (or disable shell history with `set +o history` / a leading space when `HISTCONTROL=ignorespace` is set) and pipe it over stdin, then `unset PW`:

### Option A: Before first start, with `CORAL_INITIAL_PASSWORD_FILE`

Write the password over stdin to a regular file owned by `coral` with mode `0600` and pass its path in `CORAL_INITIAL_PASSWORD_FILE`. At startup, if no password is set yet, Coral reads the first line, hashes and stores the password in `<data dir>/password`, and **deletes the file immediately**:

```bash
read -rs -p "Initial Coral password: " PW && echo
printf '%s\n' "$PW" | sudo -u coral -i bash -c 'umask 077 && cat > /home/coral/.coral-initial-password'
unset PW
```

### Option B: While Coral is running, with `coral set-password --stdin`

Once the Coral service is running on `127.0.0.1:8420`, prompt silently and pipe the first password over stdin as the `coral` user (it signs the request with `/home/coral/.coral/cli-token` without putting the password in `ps` or shell history):

```bash
read -rs -p "Initial Coral password: " PW && echo
printf '%s\n' "$PW" | sudo -u coral -i coral set-password --stdin
unset PW
```

To rotate or clear the password later (works while Coral is running or stopped, and signs out every browser session):

```bash
read -rs -p "New Coral password: " PW && echo
printf '%s\n' "$PW" | sudo -u coral -i coral reset-password --stdin
unset PW
```

See [Browser password](auth.md#browser-password).

## 5. Run Coral under systemd

Create `/etc/systemd/system/coral.service`:

```ini
[Unit]
Description=Coral server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=coral
Group=coral
WorkingDirectory=/home/coral
Environment=HOME=/home/coral
Environment=CORAL_DATA_DIR=/home/coral/.coral
Environment=PATH=/home/coral/.local/bin:/usr/local/bin:/usr/bin:/bin
# Optional: seed the initial password once on first start (file must be 0600, owned by coral; deleted after read)
# Environment=CORAL_INITIAL_PASSWORD_FILE=/home/coral/.coral-initial-password
ExecStart=/home/coral/.local/bin/coral --host 127.0.0.1 --port 8420 --no-browser
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/home/coral

[Install]
WantedBy=multi-user.target
```

> **Note — the systemd unit is not an agent sandbox:** `ProtectSystem=full` and `ProtectHome=read-only` (with `ReadWritePaths=/home/coral`) keep the service from writing to `/usr`, `/boot`, `/etc` or other users' home directories, but every agent Coral launches runs with the full read/write permissions of `User=coral` inside `/home/coral` (including `/home/coral/.coral` and any provider credentials in `/home/coral`). If your agents need to edit repositories outside `/home/coral` (for example `/srv/projects`), add that path to `ReadWritePaths=`.

If you installed the Coral binaries into `/usr/local/bin`, change `ExecStart` to `/usr/local/bin/coral --host 127.0.0.1 --port 8420 --no-browser`.

### Flags for a server

| Flag | Purpose |
|---|---|
| `--host 127.0.0.1` | Bind to loopback only (the default when remote access is off). Agents on the server always talk to Coral over loopback. |
| `--port 8420` | HTTP and WebSocket port (default `8420` on Linux/macOS; also `CORAL_PORT`). |
| `--no-browser` | Do not try to run `xdg-open` on startup. |
| `--home <dir>` | Data directory (default `~/.coral`; also `CORAL_DATA_DIR`). |
| `--backend pty\|tmux` | Terminal backend (`pty` by default). Use `--backend tmux` (with `tmux` installed) if you want agent terminals to keep running across `systemctl restart coral`. |
| `--cloud-url <url>` | Coral Hub origin (`https://app.coralhub.dev` in release builds; `--cloud-url off` disables Hub connections). |
| `--cloud-max-mode view\|interact\|launch` | Cap what Coral Hub may do on this server at startup (also `CORAL_CLOUD_MAX_MODE`). |

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coral.service
sudo systemctl status coral.service
```

Check that the server answers:

```bash
curl -s http://127.0.0.1:8420/api/health
# {"status":"ok","version":"...","hub":false}
```

## 6. Remote access: how to reach the server

Keep Coral itself listening on `--host 127.0.0.1` (do **not** expose Coral's plain-HTTP port to the internet). From strongest to weakest, choose one of:

### Option 1 (Recommended): Coral Hub or a private tunnel (SSH / Tailscale)

Neither opens a public web port on your server:

- **Coral Hub:** The server connects outbound over TLS to Coral Hub; nothing listens on the public network. On the server, run:

  ```bash
  sudo -u coral -i coral cloud connect
  ```

  Open the printed `https://app.coralhub.dev/enroll?code=...` link in your browser, approve the server, and choose its maximum access mode (**View**, **Interact** or **Launch**). See [Connecting a server to Coral Hub](hub.md#connecting-a-server-to-coral-hub).
- **SSH local port forward:** Forward port `8420` over SSH from your laptop and open `http://localhost:8420`:

  ```bash
  ssh -L 8420:127.0.0.1:8420 user@your-server
  ```

- **Tailscale:** Either forward over Tailscale SSH / `tailscale serve`, or bind to loopback and the server's tailnet IP (`--remote --host 127.0.0.1,100.x.y.z`) with a dashboard password set. See [Listening on a tailnet address](quickstart.md#listening-on-a-tailnet-address).

### Option 2: A same-computer TLS reverse proxy (nginx)

A local TLS reverse proxy (such as nginx on the same server, proxying HTTPS to `http://127.0.0.1:8420`) is **supported**, with Coral's own remote access left **off**. However, **exposing Coral on a public domain protected only by a password is the weaker choice**: Coral has no 2FA, and anyone who guesses or steals the password gets terminal access as the `coral` user and access to any agent provider logins on that server. Prefer Coral Hub, a VPN/tailnet, or an SSH tunnel whenever possible.

If you put nginx in front of `127.0.0.1:8420`, follow every rule below ([auth.md](auth.md)):

1. **Set a long dashboard password BEFORE starting or exposing the proxy** (Step 4 above), **keep strict local auth on** (the default; never pass `--strict-local-auth=false` or `CORAL_STRICT_LOCAL_AUTH=0`), **and turn on `require_auth_on_loopback` in Settings** (Section 8 below). Every request through nginx arrives at Coral from `127.0.0.1`. When nginx sends `X-Forwarded-*` headers, Coral treats the request as remote and requires a password session or API key. Warning: if `--strict-local-auth=false` is ever used and a misconfigured proxy sends no forwarding headers and keeps `Host: 127.0.0.1`, Coral admits every request as an unauthenticated local user **even when a dashboard password is set** — only keeping strict local auth on (with forwarding headers) or turning on `require_auth_on_loopback` protects a header-less loopback proxy.
2. **Pass the public `Host` header (`proxy_set_header Host $host;`).** Coral's WebSocket origin check (`wsAcceptOptions`) compares the browser's `Origin` header against the request's `Host` header directly (it does not read `X-Forwarded-Host`). If nginx leaves `Host` as `127.0.0.1:8420`, `/ws/coral` and `/ws/terminal/...` are refused. (If your public HTTPS port is not `443`, use `$http_host` instead of `$host`.)
3. **Overwrite — never append — `X-Forwarded-Host` (`proxy_set_header X-Forwarded-Host $host;`).** Browser state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) check `Origin` against `Host` or the **last** `X-Forwarded-Host` value.
4. **Send `X-Forwarded-Proto $scheme` and `X-Forwarded-For $remote_addr`.** Coral marks the session cookie `Secure` (and `__Host-` when applicable) only when it sees `X-Forwarded-Proto: https` from a trusted loopback proxy.
5. **Use HTTP/1.1 with `Upgrade` and `Connection` headers for WebSockets.** Coral's upstream listener on `127.0.0.1:8420` speaks HTTP/1.1; an HTTP/2 WebSocket upgrade to the upstream fails. Disable proxy buffering and set a long read timeout so live feeds (`/ws/coral`) and terminal streams (`/ws/terminal/...`) do not drop.

Example `/etc/nginx/sites-available/coral.conf`:

```nginx
# Before enabling this proxy: set a dashboard password (Step 4), keep strict local auth on
# (never pass --strict-local-auth=false), and turn on require_auth_on_loopback (Section 8)
# — a password alone does not protect a header-less proxy when strict local auth is off.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name coral.example.com;

    ssl_certificate     /etc/letsencrypt/live/coral.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/coral.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8420;
        proxy_http_version 1.1;

        # Required for WebSocket origin checks and browser POST/PUT/PATCH/DELETE origin checks:
        # overwrite (do not append) X-Forwarded-Host. Use $http_host if not on port 443.
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;

        # Required for /ws/coral and /ws/terminal/... WebSocket upgrades over HTTP/1.1:
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

> **If the reverse proxy is on a different machine:** Coral only trusts `X-Forwarded-*` headers from `127.0.0.1` / `::1` by default. If your proxy reaches Coral from another IP, list the proxy's IP or CIDR in `CORAL_TRUSTED_PROXIES` (for example `CORAL_TRUSTED_PROXIES=10.0.0.5`), or Coral will ignore its forwarding headers.

## 7. Launch an agent or team via the API

Once Coral is running and an agent CLI is installed and signed in as `coral`, you can launch sessions from the dashboard or from a script on the server using Coral's API key (`coral api-key`).

### Supported `agent_type` IDs

Coral accepts these `agent_type` values on `POST /api/sessions/launch` and `POST /api/sessions/launch-team`:

| `agent_type` | Binary | Notes |
|---|---|---|
| `"claude"` | `claude` | Claude Code (also the default when `agent_type` is omitted) |
| `"codex"` | `codex` | OpenAI Codex CLI |
| `"agy"` (or `"antigravity"`, `"gemini"`) | `agy` | Google Antigravity CLI (`"gemini"` is a compatibility alias that runs `agy`) |
| `"pi"` | `pi` | Pi coding agent |
| `"opencode"` | `opencode` | OpenCode CLI (requires `lsof` or `ss` on Linux) |
| `"hermes"` | `hermes` | Hermes Agent CLI (Linux and macOS) |
| `"terminal"` | — | Plain shell session with no coding agent CLI |

### Launch request (`POST /api/sessions/launch`)

`working_dir` is the only required field; all others (`agent_type`, `display_name`, `prompt`, `model`, `flags`, `permission_mode`, `board_id`, `board_name`, `backend`, `capabilities`, `tools`) are optional:

```bash
# Run as the coral user on the server (never from inside an agent)
sudo -u coral -i bash -c '
  curl -s -X POST http://127.0.0.1:8420/api/sessions/launch \
    -H "Authorization: Bearer $(coral api-key)" \
    -H "Content-Type: application/json" \
    -d "{\"working_dir\":\"/home/coral/project\",\"agent_type\":\"claude\",\"display_name\":\"server-agent\",\"prompt\":\"Run the test suite\"}"
'
```

Typical `200` response:

```json
{
  "ok": true,
  "session_id": "3ea283fc-...",
  "session_name": "claude-3ea283fc-...",
  "terminal": "pty",
  "launch_path": "pty",
  "permission_lowering": "To lower it: pass a lower permission mode when you launch (a CLI permission flag, or permission_mode default), or set a default permission mode in Settings.",
  "launch_disclosure": {
    "id": "full-permissions-5",
    "text": "In auto mode, an agent works without stopping to ask you: it runs commands and edits files on its own. Each CLI has its own safety checks. To use a different mode, change the default in Settings > Defaults."
  }
}
```

### The first-launch permission disclosure (do not acknowledge on a person's behalf)

New agents default to **Auto** permission mode (they run commands and edit files without stopping at every prompt, using each CLI's own safety checks). Coral includes a one-time first-launch notice (`GET /api/launch-disclosure`, acknowledged via `POST /api/launch-disclosure/ack {"id": "<id>"}`):

- **API-key and CLI launches never block on this notice:** A `POST /api/sessions/launch` authenticated with `Authorization: Bearer $(coral api-key)` (or a command-line signature, or an explicit `"permission_mode": "default"`) **succeeds immediately** without needing `POST /api/launch-disclosure/ack`; Coral includes the `launch_disclosure` object in the `200` JSON response so the caller can read it. Only a browser launch from the dashboard's own dialog (authenticated by a dashboard session cookie before the person has clicked **I've read this** / **Dismiss** / **Continue launch**) returns `409` `launch_disclosure_required`.
- **An installing or deploying agent must NEVER call `POST /api/launch-disclosure/ack` on the user's behalf:** Like the Terms of Service, the permission disclosure is a notice for the human Operator. If you are an agent setting up Coral or launching a test session, either launch with the API key (which does not require acknowledging the disclosure) or pass `"permission_mode": "default"`, and show the `launch_disclosure.text` notice to the person so they can read and acknowledge it themselves in the dashboard.

For full request fields, permission modes, team launches (`POST /api/sessions/launch-team`), terminal control (`POST /api/sessions/live/{name}/send` and `/keys`), and WebSocket streams:

- [Sessions API (`POST /api/sessions/launch` and `/api/sessions/launch-team`)](sessions.md#session-lifecycle)
- [WebSocket API (`/ws/coral` and `/ws/terminal/{name}`)](websockets.md)
- [Authentication (`auth.md`)](auth.md)
- [Coral Hub & multi-server (`hub.md`)](hub.md)

## 8. Hardening, logs, and backups

### Firewall: never expose port `8420`

Keep Coral bound to `--host 127.0.0.1` and allow only the ports you use in your host firewall (`ufw` or `nftables`):

- **With Coral Hub or Tailscale:** No inbound public ports are needed beyond SSH (`22/tcp`, ideally restricted to your IP or tailnet).
- **With a same-computer nginx TLS proxy:** Allow `22/tcp` (SSH), `80/tcp` (HTTP for ACME / redirect) and `443/tcp` (HTTPS), and **never** open `8420/tcp`:

  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw deny 8420/tcp
  sudo ufw enable
  ```

### Require credentials on loopback (`require_auth_on_loopback`) and turn off usage analytics (`telemetry_enabled`)

You can set Coral's settings from the command line as the `coral` service user with **`coral-board settings set <key> <value>`** (which signs `PUT /api/settings` with `/home/coral/.coral/cli-token`), or with `curl` and the API key (`PUT /api/settings`):

| Setting | Key in `PUT /api/settings` | Default | Values | Effect |
|---|---|---|---|---|
| **Require credentials on loopback** | `require_auth_on_loopback` | `"false"` | `"true"` / `"false"` (or JSON `true` / `false`) | Applies immediately. Even direct loopback requests without forwarding headers must present a valid credential. |
| **Usage analytics** | `telemetry_enabled` | `"true"` | `"false"` / `"true"` (or JSON `false` / `true`) | Applies immediately. Turns off anonymous usage telemetry (same as **Settings > Security and privacy > Usage analytics**). You can also set `Environment=CORAL_TELEMETRY_DISABLED=1` in `coral.service` to disable telemetry at startup regardless of the database setting ([telemetry.md](telemetry.md)). |

Set both from a shell on the server with `coral-board settings set`:

```bash
sudo -u coral -i coral-board settings set require_auth_on_loopback true
sudo -u coral -i coral-board settings set telemetry_enabled false
```

Or in one `PUT /api/settings` call with the API key:

```bash
sudo -u coral -i bash -c '
  curl -s -X PUT http://127.0.0.1:8420/api/settings \
    -H "Authorization: Bearer $(coral api-key)" \
    -H "Content-Type: application/json" \
    -d "{\"require_auth_on_loopback\":true,\"telemetry_enabled\":false}"
'
# {"ok":true}
```

#### Do agents' `coral-board` and `coral-agent` tools still work with `require_auth_on_loopback` on?

**Yes.** Turning `require_auth_on_loopback` on makes direct loopback requests **strict-local, not remote** ([auth.md](auth.md)):

- Every agent session Coral launches receives a per-session token (`CORAL_SESSION_TOKEN` / `X-Coral-Session-Token`), and `coral-board`, `coral-agent` and every `coral-hook-*` binary send it automatically on `127.0.0.1:8420`.
- The signed `coral` and `coral-board` commands run by the `coral` OS user on the server send a one-time HMAC signature (`<data dir>/cli-token`), and the dashboard sends its session cookie.
- **What stops working:** Only unauthenticated bare requests on loopback (such as a bare `curl http://127.0.0.1:8420/api/sessions/live` with no `-H "Authorization: Bearer $(coral api-key)"`) and tokenless plain terminal sessions if `--strict-local-auth=false` was set.
- **Emergency recovery:** If `require_auth_on_loopback` ever locks out a custom local script, starting Coral with `CORAL_REQUIRE_AUTH_ON_LOOPBACK=off` overrides the saved setting at startup.

### Log rotation

Coral rotates its own logs inside `<data dir>` (`/home/coral/.coral`) automatically — you do not need `logrotate`:

- **`coral.log`** (`/home/coral/.coral/coral.log`): Rotated by size at **20 MB**, keeping **5 older copies** (`coral.log.1` through `coral.log.5`, ~120 MB max). Secrets and the user's home path are redacted automatically before lines are written.
- **Agent terminal logs** (`/home/coral/.coral/logs/<agent>_coral_<id>.log`): Kept until you delete them so you can inspect or resume past sessions. Clean up ended agents' logs from **Settings > Storage and backup > Terminal logs**, or remove old files in `/home/coral/.coral/logs/`.
- **Artifact storage**: Prune old stored diffs or objects from the command line with `sudo -u coral -i coral artifacts prune --older-than 14d --dry-run` (add `--yes` to delete), or set **Artifact store limit (GiB)** (`artifact_store_max_bytes`) and **Automatic cleanup (days)** (`artifact_retention_days`) in Settings.

### Backing up and restoring the data directory

All persistent state lives in `/home/coral/.coral` (primarily the two SQLite WAL databases `sessions.db` and `messageboard.db`, plus `api_key`, `password`, `artifacts/`, `uploads/` and `agent_knowledge/`):

- **Cold backup (simplest):** Stop the service briefly (`sudo systemctl stop coral`), archive `/home/coral/.coral` with permissions preserved (`sudo tar -C /home/coral -czpf coral-backup.tar.gz .coral`), and start Coral again (`sudo systemctl start coral`).Keep the backup archive `0600` — it contains `api_key`, `password` (hash) and unredacted terminal logs.
- **Online SQLite snapshot:** If you back up while Coral is running, use `sqlite3 /home/coral/.coral/sessions.db ".backup '/path/to/sessions-backup.db'"` and `sqlite3 /home/coral/.coral/messageboard.db ".backup '/path/to/messageboard-backup.db'"` (under `umask 077`) rather than copying raw `.db` files without their `-wal` journals.
- **Compacting or repairing `sessions.db`:** With Coral stopped, `sudo -u coral -i coral db compact` writes a `0600` backup (`sessions.before-compact-<time>.db`) and `VACUUM`s `sessions.db`; `sudo -u coral -i coral db rebuild-search` rebuilds the FTS5 search index.
- **Restoring to a new server or path (`--adopt-data-dir`):** Coral stamps a data-directory ID in both the folder and the database so it can warn if a database was copied from another instance. After restoring a backup onto a new server or path (with `coral.service` stopped), adopt the restored folder once as the `coral` user before starting the service:

  ```bash
  sudo -u coral -i coral --adopt-data-dir
  ```

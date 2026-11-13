---
title: "Run Coral on several machines"
description: "Connect Coral on several machines to one hub and see all their agents and teams in a single dashboard, with chat and terminals."
---

# Multi-server hub

Run Coral on several machines (a laptop, a workstation, a cloud box) and see all of their agents and teams in one dashboard. One Coral server acts as the **hub**. The others are **remotes** (also called spokes). The hub shows the remotes' agents next to its own, lets you open their chat and terminal views, and lets you launch agents and teams on them.

A remote is an ordinary standalone Coral server. It needs no special mode and no changes. The hub calls the same API your browser uses, through an authenticated proxy.

!!! note "What the hub does not do"
    A team, its message board and its agents all live on one server. The hub does not make one team span two machines.

## Set it up

### 1. Turn on the hub

On the computer you will use as the hub, turn on **Run a hub on this computer** on Coral's Home page (Coral 2.0.65 or later). Turning it on asks first. The setting is saved and applied when Coral restarts.

`coral --hub` and `CORAL_HUB=1 coral` still work as well:

```bash
coral --hub
# or
CORAL_HUB=1 coral
```

Without hub mode nothing about the hub exists: the hub routes are not registered and the UI shows none of it.

### 2. Add a computer

In the hub's top bar, open the settings menu and choose **Computers**, then **Add computer**. There are two ways to connect a computer.

**Set up over SSH (hub on Coral 2.0.10 or later).** Choose **Set up over SSH**. The hub installs, verifies and starts Coral on that computer for you. The hub reaches the computer by `ssh -W` to the computer's own loopback address, so no port is opened to the network and you do not need to turn on remote access.

**Add by URL and API key.** This is the original way, and it still works. On the remote computer:

1. Turn on [remote access](remote-access.md) and restart, so Coral listens on a network address and not only on `127.0.0.1`.
2. Copy its API key. It is shown with the QR code, and stored in `~/.coral/api_key`.

Then, in the hub, fill in:

| Field | Meaning |
| --- | --- |
| **Computer id** | A short name using lowercase letters, digits and `-` (up to 32 characters). It appears in URLs and cannot be `local`. |
| **Display name** | The name shown in the dashboard. |
| **URL** | The remote's address, for example `http://192.168.1.20:8420`. |
| **API key** | The remote's key. Write-only: it is never shown again. |
| **Allow private network address** | Turn this on for LAN, tailnet or localhost remotes. |

A computer added by URL is reached over plain HTTP by default; start it with `--tls-cert` and `--tls-key` to serve HTTPS on the port. Otherwise use a network you trust, a VPN or tailnet, or put your own encrypted tunnel in front of it. This applies only to computers added by URL.

The hub checks the computer's health with the key before it saves anything. Use **Test** later to re-run the check.

!!! warning "Private addresses are blocked by default"
    To stop the hub being used to reach arbitrary hosts, it refuses private and reserved addresses unless **Allow private network address** is on for that computer. The address is checked again each time the hub connects, not only when you register it.

## Using it

- **Sidebar.** Remote agents and teams appear with a server badge. If there are no remotes, the sidebar looks exactly as it does without the hub. The Computers tab and a status strip show whether each remote is online, unreachable, or has a rejected key.
- **Chat and terminal.** Select a remote agent as you would a local one. Chat, terminal, files, tasks, notes and the message board all go through the hub to the remote, and their paths are the remote's paths.
- **Offline remotes.** When a remote is unreachable its last known agents stay in the list, greyed out and not actionable, until it comes back.
- **Needs you.** The Needs you list covers every connected computer (Coral 2.0.65 or later).
- **Popout.** A remote agent opens at `/agent/{server}/{id}`. The old `/agent/{id}` still means a local agent.

### Launching on a remote

The launch dialogs (agent, team, terminal, quick launch) gain a **Computer** picker when at least one remote is registered. Pick a remote and:

- **Browse** lists the remote's folders. It asks the remote to list its own filesystem, so you see the remote's folders, starting at the remote's home directory, not the hub's.
- Paths are only ever interpreted by the server that will run the agent. Changing the server clears the directory field, so a path from one machine is never sent to another.
- Agent types, installed-CLI checks, default models and the default working directory all come from the selected remote. If `claude` is missing on the remote you are told, even if it is installed on the hub.
- If the remote is offline or rejects the key, the launch fails with an error. It is never started on the hub instead.
- Adding an agent to an existing remote team stays on that team's server, and the picker is locked.

## Security

- **Keys are encrypted at rest.** This holds for both ways of adding a computer. Each remote's API key is encrypted with AES-256-GCM, bound to the server ID. The master key lives in `<Coral data dir>/.remote_secret_key` with permissions `0600`, outside the database, so a copy of the database file alone does not expose the keys. Set `CORAL_SECRET_KEY` to supply the master key from your own secret store instead.
- **Keys never reach the browser.** The browser's own credentials are stripped before a request is forwarded, and the remote's key is added by the hub. No API returns a stored key.
- **Back up the key file with the database.** If `.remote_secret_key` is lost, the remotes show `key_unreadable` and you re-enter each key. Nothing else is affected.
- **The hub holds keys that give full control of each remote.** Anyone who can use the hub's web UI can reach every registered remote, so protect the hub as you would the remotes themselves.
- **SSH access.** Whoever controls the hub's Coral or the account it runs as can reach every computer you set up over SSH with your SSH access, so protect the hub computer as you would your SSH keys.
- Encryption protects the database and its backups. It does not protect against someone who already controls the hub's user account or process.

## Troubleshooting

| You see | Likely cause |
| --- | --- |
| No **Computers** entry | Hub mode is not turned on, or Coral has not been restarted since you turned it on. |
| Registering fails with a private-address error | Turn on **Allow private network address** for that computer. |
| Status **unreachable** | The remote is down, the URL or port is wrong, or the remote is still listening on loopback only. Enable remote access on it and restart. |
| Status **unauthorized** | The remote rejected the key. It may have been regenerated. Edit the computer and paste the new key. |
| Status **key_unreadable** | The hub's master key changed or is missing. Re-enter the key. |
| A remote agent is greyed out | The remote is offline. Its agents return when it reconnects. |
| New remote agent takes a few seconds to appear after launch | The hub learns of it on its next poll (about 5 seconds). |

## Known limits in this version

- Resuming an ended session from history uses the hub's own history, so a remote's past sessions cannot be resumed from the hub. Open the remote's own dashboard for that.
- The hub's History tab covers the hub only.
- Directory browsing assumes forward-slash paths, so a Windows remote is not supported for browsing.
- A hub shows only the agents that run on each remote directly. If a remote is itself a hub, its own remotes are not shown a second time.
- Do not register the hub as a remote of itself. Its agents would appear twice.

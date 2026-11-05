#!/usr/bin/env bash
#
# One-time setup of the restricted account on the mini that runs the heavy commands (#13719 step 2). Run it AS THAT ACCOUNT (a Standard macOS user such as coralrun), never as root and never as the Operator's own
# account. It writes only inside that account's home:
#   ~/coral-test (0700)         the folder the runs are made in, one fresh folder per run, removed afterwards
#   ~/bin/coral-heavy-run       the wrapper (the only thing the key may run)
#   ~/.local/go, ~/.local/node  Go and Node for the commands (checked against the official checksums)
#   ~/.ssh/authorized_keys      ONE line:  restrict,command="<home>/bin/coral-heavy-run" <the Mac's public key>
# so that key can run the wrapper and nothing else: no shell, no forwarding, none of the Operator's files or keychain.
#
# Usage: mini-setup.sh --pubkey "ssh-ed25519 AAAA... coral-heavy" --wrapper ./coral-heavy-run [--go 1.26.10] [--node 22.23.4] [--skip-toolchains] [--dry-run]
#   --pubkey   the public key made on the Mac (ssh-keygen -t ed25519 -f ~/.ssh/coral_heavy -N ""): the content of coral_heavy.pub
#   --wrapper  the built wrapper for this machine: on the Mac, GOOS=darwin GOARCH=arm64 go build -o coral-heavy-run ./cmd/coral-heavy-run (from coral-go), copied here
# It never touches any ssh setting beyond that account's own authorized_keys.
set -euo pipefail

PUBKEY=""; WRAPPER=""; GOVER="1.26.10"; NODEVER="22.23.4"; SKIP_TOOLS=0; DRY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pubkey) PUBKEY="${2-}"; shift 2 ;;
        --wrapper) WRAPPER="${2-}"; shift 2 ;;
        --go) GOVER="${2-}"; shift 2 ;;
        --node) NODEVER="${2-}"; shift 2 ;;
        --skip-toolchains) SKIP_TOOLS=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

die() { echo "mini-setup: $*" >&2; exit 1; }
say() { if [[ $DRY -eq 1 ]]; then echo "would: $*"; else echo "$*"; fi; }
do_() { if [[ $DRY -eq 0 ]]; then "$@"; fi; }

[[ "$(id -u)" -ne 0 ]] || die "do not run this as root: run it as the dedicated account"
[[ -n "${HOME:-}" && "$HOME" == /* ]] || die "no home folder"
# a plain ed25519 public key and an optional comment of letters, digits, dot, dash and underscore: nothing that could be an option, a second line or a quote
[[ "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]{60,100}={0,2}(\ [A-Za-z0-9._-]{1,64})?$ ]] || die "--pubkey must be one plain 'ssh-ed25519 AAAA... [comment]' line (no options, no newline, no quotes)"
[[ -n "$WRAPPER" && -f "$WRAPPER" ]] || die "--wrapper must be the built coral-heavy-run file"
[[ "$GOVER" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ && "$NODEVER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad --go or --node version"

say "make $HOME/coral-test and $HOME/bin (private)"
if [[ $DRY -eq 0 ]]; then
    mkdir -p "$HOME/coral-test" "$HOME/bin"
    chmod 700 "$HOME/coral-test" "$HOME/bin"
fi
say "install the wrapper at $HOME/bin/coral-heavy-run (read and run by this account only)"
if [[ $DRY -eq 0 ]]; then
    install -m 0500 "$WRAPPER" "$HOME/bin/coral-heavy-run.new"
    mv -f "$HOME/bin/coral-heavy-run.new" "$HOME/bin/coral-heavy-run"
fi

if [[ $SKIP_TOOLS -eq 0 ]]; then
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64) GOOS=darwin; GOARCH=arm64; NODEARCH=darwin-arm64 ;;
        Darwin-x86_64) GOOS=darwin; GOARCH=amd64; NODEARCH=darwin-x64 ;;
        Linux-x86_64) GOOS=linux; GOARCH=amd64; NODEARCH=linux-x64 ;;
        Linux-aarch64) GOOS=linux; GOARCH=arm64; NODEARCH=linux-arm64 ;;
        *) die "no toolchain download for $(uname -s)-$(uname -m): use --skip-toolchains and install Go and Node under ~/.local" ;;
    esac
    fetch_checked() { # url sha256 dest
        local tmp; tmp="$(mktemp)"
        curl -fsSL "$1" -o "$tmp"
        local got; got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
        [[ "$got" == "$2" ]] || { rm -f "$tmp"; die "checksum of $1 is $got, not $2"; }
        mv "$tmp" "$3"
    }
    say "install Go $GOVER and Node $NODEVER under $HOME/.local (official downloads, checked against the published SHA-256)"
    if [[ $DRY -eq 0 ]]; then
        mkdir -p "$HOME/.local"
        gosum="$(curl -fsSL "https://go.dev/dl/?mode=json&include=all" | python3 -c 'import json,sys; v="go'"$GOVER"'"; f="go'"$GOVER"'.'"$GOOS-$GOARCH"'.tar.gz"
for r in json.load(sys.stdin):
    if r["version"]==v:
        for x in r["files"]:
            if x["filename"]==f: print(x["sha256"])')"
        [[ -n "$gosum" ]] || die "no checksum published for go$GOVER $GOOS-$GOARCH"
        fetch_checked "https://go.dev/dl/go$GOVER.$GOOS-$GOARCH.tar.gz" "$gosum" "$HOME/.local/go.tgz"
        rm -rf "$HOME/.local/go" && tar -C "$HOME/.local" -xzf "$HOME/.local/go.tgz" && rm -f "$HOME/.local/go.tgz"
        nsum="$(curl -fsSL "https://nodejs.org/dist/v$NODEVER/SHASUMS256.txt" | awk -v f="node-v$NODEVER-$NODEARCH.tar.gz" '$2==f {print $1}')"
        [[ -n "$nsum" ]] || die "no checksum published for node v$NODEVER $NODEARCH"
        fetch_checked "https://nodejs.org/dist/v$NODEVER/node-v$NODEVER-$NODEARCH.tar.gz" "$nsum" "$HOME/.local/node.tgz"
        rm -rf "$HOME/.local/node" "$HOME/.local/node-v$NODEVER-$NODEARCH" && tar -C "$HOME/.local" -xzf "$HOME/.local/node.tgz" && rm -f "$HOME/.local/node.tgz"
        mv "$HOME/.local/node-v$NODEVER-$NODEARCH" "$HOME/.local/node"
    fi
fi

LINE="restrict,command=\"$HOME/bin/coral-heavy-run\" $PUBKEY"
say "write the one restricted line to $HOME/.ssh/authorized_keys: $LINE"
if [[ $DRY -eq 0 ]]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    touch "$HOME/.ssh/authorized_keys"
    chmod 600 "$HOME/.ssh/authorized_keys"
    tmp="$(mktemp "$HOME/.ssh/ak.XXXXXX")"
    grep -v -F "bin/coral-heavy-run\"" "$HOME/.ssh/authorized_keys" > "$tmp" || true # this script's own earlier line goes; every other key stays
    echo "$LINE" >> "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$HOME/.ssh/authorized_keys"
fi

HOSTNAME_NOW="$(hostname)"
cat <<EOF

Done on this machine. Now, on the MAC (the Operator's own account), two things:

1. Add this block to ~/.ssh/config (the address is this machine's name or IP as the Mac reaches it):

Host coral-heavy-mini
    HostName ${HOSTNAME_NOW}
    User $(id -un)
    IdentityFile ~/.ssh/coral_heavy
    IdentitiesOnly yes
    StrictHostKeyChecking yes

2. Pin this machine's host key, after checking its fingerprint matches. Here, as an admin, show it:
       ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   then on the Mac, add the key and compare the fingerprint it prints to the one above BEFORE trusting it:
       ssh-keyscan -t ed25519 ${HOSTNAME_NOW} | tee /tmp/mini_hostkey.txt | ssh-keygen -lf -
       cat /tmp/mini_hostkey.txt >> ~/.ssh/known_hosts

Test (from the Mac; it prints "refused: not a heavy-run stream" because it sends nothing, which is the wrapper answering):
       ssh -T coral-heavy-mini
EOF

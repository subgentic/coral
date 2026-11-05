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
# Usage: mini-setup.sh --pubkey "ssh-ed25519 AAAA... coral-heavy" --wrapper ./coral-heavy-run [--skip-toolchains] [--dry-run]
#        [--go VER --go-sha256 HEX] [--node VER --node-sha256 HEX]   (only to use a version other than the pinned ones, with its published checksum)
#   --pubkey   the public key made on the Mac (ssh-keygen -t ed25519 -f ~/.ssh/coral_heavy -N ""): the content of coral_heavy.pub
#   --wrapper  the built wrapper for this machine: on the Mac, GOOS=darwin GOARCH=arm64 go build -o coral-heavy-run ./cmd/coral-heavy-run (from coral-go), copied here
# The Go and Node checksums of the default versions are written in this file (reviewed with it), not fetched from the download site. It never touches any ssh setting beyond that account's own authorized_keys.
set -euo pipefail

DEFAULT_GO="1.26.10"; DEFAULT_NODE="22.23.4"
PUBKEY=""; WRAPPER=""; GOVER="$DEFAULT_GO"; NODEVER="$DEFAULT_NODE"; GOSUM=""; NODESUM=""; SKIP_TOOLS=0; DRY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pubkey) PUBKEY="${2-}"; shift 2 ;;
        --wrapper) WRAPPER="${2-}"; shift 2 ;;
        --go) GOVER="${2-}"; shift 2 ;;
        --node) NODEVER="${2-}"; shift 2 ;;
        --go-sha256) GOSUM="${2-}"; shift 2 ;;
        --node-sha256) NODESUM="${2-}"; shift 2 ;;
        --skip-toolchains) SKIP_TOOLS=1; shift ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
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

# the checksums of the default versions, copied from the official checksum lists of go.dev and nodejs.org, written here so a changed download site cannot change both the file and its checksum
pinned_go() { case "$1" in
    darwin-arm64) echo 0b5183492292ada170f9b561a834863808dd02edba599e4ad0e89899330020b3 ;;
    darwin-amd64) echo e820ab780c273ae4a340b79d0f3c4313b74ee029aa3874792145d44b9f4f91da ;;
    linux-amd64) echo ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5 ;;
    linux-arm64) echo 3f4227ce7b206a513e794f1393adb473a07b46e94d18bd15d1c684bbb7319797 ;;
esac; }
pinned_node() { case "$1" in
    darwin-arm64) echo c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    darwin-x64) echo efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    linux-arm64) echo f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9 ;;
    linux-x64) echo b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
esac; }
if [[ $SKIP_TOOLS -eq 0 ]]; then
    # a version other than the pinned one needs its own published checksum, given here (nothing is taken from the site that serves the file)
    [[ "$GOVER" == "$DEFAULT_GO" || "$GOSUM" =~ ^[0-9a-f]{64}$ ]] || die "--go $GOVER is not the pinned version ($DEFAULT_GO): give its published checksum with --go-sha256"
    [[ "$NODEVER" == "$DEFAULT_NODE" || "$NODESUM" =~ ^[0-9a-f]{64}$ ]] || die "--node $NODEVER is not the pinned version ($DEFAULT_NODE): give its published checksum with --node-sha256"
fi

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
        gosum="${GOSUM:-$(pinned_go "$GOOS-$GOARCH")}"
        [[ -n "$gosum" ]] || die "no pinned Go checksum for $GOOS-$GOARCH: give --go-sha256"
        fetch_checked "https://go.dev/dl/go$GOVER.$GOOS-$GOARCH.tar.gz" "$gosum" "$HOME/.local/go.tgz"
        rm -rf "$HOME/.local/go" && tar -C "$HOME/.local" -xzf "$HOME/.local/go.tgz" && rm -f "$HOME/.local/go.tgz"
        nsum="${NODESUM:-$(pinned_node "$NODEARCH")}"
        [[ -n "$nsum" ]] || die "no pinned Node checksum for $NODEARCH: give --node-sha256"
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

2. Pin this machine's host key, after checking its fingerprint. Here on the mini, as an admin, show it:
       ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   then on the Mac write the scanned key to a file in YOUR OWN home (never a shared folder like /tmp, where another user could swap it), compare its fingerprint with the one above, and only if they match add it:
       ssh-keyscan -t ed25519 ${HOSTNAME_NOW} > ~/mini_hostkey.txt
       ssh-keygen -lf ~/mini_hostkey.txt        # compare this fingerprint with the one the mini showed
       cat ~/mini_hostkey.txt >> ~/.ssh/known_hosts && rm ~/mini_hostkey.txt

Test (from the Mac; it prints "refused: not a heavy-run stream" because it sends nothing, which is the wrapper answering):
       ssh -T coral-heavy-mini
EOF

#!/usr/bin/env bash
# tests/ssh_docker/run_on_epoch.sh ID: SSH setup against real sshd in Docker containers, with a real ProxyJump (#170), on the shared test host "epoch".
#
#   EPOCH_HOST=epoch EPOCH_ROOT=/sd2/cknorowski tests/ssh_docker/run_on_epoch.sh sshdk1     (from the top of a clean worktree)
#
# It ships this worktree's committed tree (git archive of HEAD) to $EPOCH_ROOT/coralgo-sshdocker-ID, runs the opt-in test TestSSHDocker there (build tag sshdocker; go test -p 1, nice 10, ionice idle), prints its
# whole log, and removes the folder by its exact path. The test makes three containers (a jump and a far computer with users alice and bob), a private docker network and an image, all named sshdk-<random>, and
# removes them by name on exit; afterwards this script lists any container, network or image still carrying that prefix. No real credential: the key is made for the run, no agent, no published port, no ~/.coral.
set -uo pipefail
ID=${1:?usage: tests/ssh_docker/run_on_epoch.sh ID}
case "$ID" in *[!A-Za-z0-9._-]*) echo "ID may hold only letters, digits, . _ -" >&2; exit 2 ;; esac
H=${EPOCH_HOST:-epoch}; ROOT=${EPOCH_ROOT:?set EPOCH_ROOT to the gate root on the host}
D=coralgo-sshdocker-$ID
top=$(git rev-parse --show-toplevel) || exit 2
cd "$top" || exit 2
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit first: this runs HEAD" >&2; exit 2; }
echo "sshdocker $ID: $(git rev-parse --short HEAD) -> $H:$ROOT/$D"
git archive --format=tar HEAD coral-go tests | gzip |
  ssh -o BatchMode=yes "$H" "umask 022; rm -rf -- '$ROOT/$D' && mkdir -p '$ROOT/$D' && cd '$ROOT/$D' && tar xzf - 2>/dev/null" || exit 1
ssh -o BatchMode=yes "$H" "ROOT='$ROOT' D='$D' NOTEL='${SSHDOCKER_NO_TELEMETRY:-0}' bash -s" <<'REMOTE'
umask 022
N=$ROOT
export PATH=$HOME/go-install/go/bin:$PATH GOCACHE=$N/coralgo-cache/gocache GOMODCACHE=$N/coralgo-cache/gomodcache TMPDIR=$N/coralgo-tmp
unset CORAL_CLOUD_URL CORAL_DIR CORAL_DATA_DIR CORAL_URL TMUX SSH_AUTH_SOCK
export CORAL_TELEMETRY_DISABLED=1 SSHDOCKER=1 SSHDOCKER_NO_TELEMETRY='$NOTEL'
cd $N/$D/coral-go || exit 1
echo "before: containers=$(docker ps -aq | wc -l) networks=$(docker network ls -q | wc -l) load=$(cut -d' ' -f1-3 /proc/loadavg)"
nice -n 10 ionice -c3 go test -tags sshdocker -run TestSSHDocker -p 1 -count=1 -v -timeout 25m ./internal/sshprov/ 2>&1
echo "go test exit: $?"
echo "left over by name (must be empty):"
docker ps -a --format '{{.Names}}' | grep '^sshdk-'; docker network ls --format '{{.Name}}' | grep '^sshdk-'; docker images --format '{{.Repository}}' | grep '^sshdk-'
echo "after: containers=$(docker ps -aq | wc -l) networks=$(docker network ls -q | wc -l)"
cd / && rm -rf -- "$N/$D"
REMOTE

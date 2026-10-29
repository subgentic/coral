#!/bin/bash
# Checks the egress block of a Coral cloud machine on a REAL machine (#10918, coral-hub Security's condition): as a non-root user the metadata service and a private (VPC) address are unreachable, a public
# address is reachable, root still reaches the metadata service, and the rule is there again after a reboot.
#
# NOT RUN BY ITS AUTHOR: it needs a real droplet and a spend-limited token, which the author did not have. The rules themselves were loaded and tested in a throwaway network namespace (see the commit);
# the real machine, the cloud's own network and the reboot are what this checks.
#
# Use, on a fresh Ubuntu 24.04 droplet (ideally in a VPC, with a second droplet in it for --vpc-address), as root:
#   coral machine egress-files --dir ./egress        # on your own computer: no provider call, no secret; copy ./egress to the droplet
#   sudo tools/machine-egress-check.sh ./egress [--vpc-address 10.116.0.3]   # installs the files, loads the block, checks it
#   sudo reboot
#   sudo tools/machine-egress-check.sh --after-reboot [--vpc-address 10.116.0.3]
set -u
vpc=""; after=0; dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --after-reboot) after=1 ;;
    --vpc-address) vpc="${2:-}"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) dir="$1" ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
command -v nft >/dev/null || { echo "nft is not installed (apt-get install -y nftables)" >&2; exit 2; }
fails=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; fails=$((fails+1)); }

if [ "$after" = 0 ]; then
  [ -n "$dir" ] && [ -f "$dir/egress.nft" ] && [ -f "$dir/coral-egress.service" ] && [ -f "$dir/coral-egress-resolvers.service" ] && [ -f "$dir/coral-egress-check" ] || { echo "usage: $0 DIR [--vpc-address ADDR]   (DIR from 'coral machine egress-files --dir DIR')" >&2; exit 2; }
  install -d -m 0755 /etc/coral
  install -m 0600 "$dir/egress.nft" /etc/coral/egress.nft
  install -m 0644 "$dir/coral-egress.service" /etc/systemd/system/coral-egress.service
  install -m 0644 "$dir/coral-egress-resolvers.service" /etc/systemd/system/coral-egress-resolvers.service
  install -m 0700 "$dir/coral-egress-check" /usr/local/sbin/coral-egress-check
  systemctl daemon-reload
  systemctl enable coral-egress-resolvers.service
  systemctl enable --now coral-egress.service || bad "the unit did not start: $(journalctl -u coral-egress.service -n 5 --no-pager 2>/dev/null)"
fi

systemctl is-active --quiet coral-egress.service && ok "coral-egress.service is active" || bad "coral-egress.service is not active"
[ "$(nft list table inet coral_egress 2>/dev/null | grep -c 'meta skuid != 0')" -ge 2 ] && ok "the nftables table has both rules" || bad "the nftables table is missing or incomplete"
systemctl show coral-egress.service -p Before | grep -q network-pre.target && ok "the unit is ordered before network-pre.target" || bad "the unit is not ordered before network-pre.target"

id egresscheck >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin egresscheck
as_user() { setpriv --reuid="$(id -u egresscheck)" --regid="$(id -g egresscheck)" --clear-groups "$@"; }

# 1. the metadata service
if as_user curl -sS -m 6 -o /dev/null http://169.254.169.254/metadata/v1/id 2>/dev/null; then bad "a non-root user REACHED the metadata service"; else ok "a non-root user cannot reach the metadata service"; fi
if curl -sS -m 6 http://169.254.169.254/metadata/v1/id 2>/dev/null | grep -Eq '^[0-9]+$'; then ok "root still reaches the metadata service (cloud-init keeps what it needs)"; else bad "root cannot reach the metadata service (cloud-init may be broken)"; fi

# 2. a private address: the one given, else this machine's own private address
priv="$vpc"
[ -n "$priv" ] || priv="$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1)"
if [ -z "$priv" ]; then
  echo "SKIP  no private address found (is this droplet in a VPC?): pass --vpc-address ADDR"
else
  if as_user curl -sS -m 6 -o /dev/null "http://$priv:22/" 2>/dev/null; then bad "a non-root user REACHED the private address $priv"; else ok "a non-root user cannot reach the private address $priv"; fi
fi

# 3. a public address, as a non-root user
if as_user curl -sS -m 10 -o /dev/null https://api.digitalocean.com/v2/ 2>/dev/null; then ok "a non-root user reaches a public address"; else bad "a non-root user cannot reach a public address (a DNS resolver in a blocked range?)"; fi
as_user getent hosts api.digitalocean.com >/dev/null && ok "a non-root user resolves names" || bad "a non-root user cannot resolve names"

# 4. the resolvers are public (the unit's own check)
/usr/local/sbin/coral-egress-check rules && ok "the unit's own rules check passes" || bad "the unit's own rules check fails"
resolver_say=$(/usr/local/sbin/coral-egress-check resolvers 2>&1)
[ -z "$resolver_say" ] && ok "no DNS resolver is inside a blocked range (checked now, with the network online)" || bad "$resolver_say"
systemctl is-enabled --quiet coral-egress-resolvers.service && ok "the resolver check is enabled for every boot (after network-online.target)" || bad "the resolver check is not enabled"

if [ "$after" = 0 ]; then echo; echo "Now reboot (sudo reboot) and run: sudo $0 --after-reboot${vpc:+ --vpc-address $vpc}"; fi
echo; [ "$fails" = 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit $((fails > 0))

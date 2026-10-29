package machinelaunch

import (
	"fmt"
	"strings"
)

// The egress block (#10918, coral-hub Security's ruling): on the machine, every non-root user is stopped from reaching the cloud's metadata service and the private network ranges, from the first boot.
// Coral talks to the public Hub URL and the model providers only, so neither it nor an agent needs the metadata service (the user-data, which holds the host key and the setup values, is readable there)
// or a VPC neighbour; the Coral service user is the one account that could be talked into reading either, so it is covered as well. Root and cloud-init keep what they need.
//
// The rule is scoped by user id (skuid != 0), not by program, on the output chain, loaded by a unit that runs before the network is configured and before coral.service can start, and that coral.service
// Requires: a machine where the rule did not load does not start Coral. A non-root user cannot change it (it has no sudo on these machines). Loopback is not in the lists, so systemd-resolved's 127.0.0.53
// keeps answering. A check after the load reads the machine's DNS resolvers and fails if one is inside a blocked range (Coral's own lookups would fail).
//
// It stops the metadata service and the private ranges being read; it does not stop an agent using the machine as a proxy to the public internet: that is the CLI permissions' job, as on any machine.

// Where the pieces go on the machine.
const (
	egressRulesPath  = "/etc/coral/egress.nft"
	egressUnitPath   = "/etc/systemd/system/coral-egress.service"
	egressCheckPath  = "/usr/local/sbin/coral-egress-check"
	egressUnitName   = "coral-egress.service"
	egressTableName  = "coral_egress"
	egressRulePrio   = -10
	egressMetadataV4 = "169.254.169.254"
)

// egressBlockedV4 and egressBlockedV6 are the ranges a non-root user cannot reach: link-local (the metadata address is inside it), the three RFC 1918 blocks, and the carrier-grade NAT block (a VPC
// can be numbered from it). DigitalOcean documents the metadata service at 169.254.169.254 and no IPv6 metadata address; the IPv6 lists keep link-local and unique-local space shut all the same.
var (
	egressBlockedV4 = []string{"169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"}
	egressBlockedV6 = []string{"fe80::/10", "fc00::/7"}
)

// EgressSummary is the sentence the launch's confirm shows: what is blocked, and for whom.
func EgressSummary() string {
	return fmt.Sprintf("On the machine, every non-root user (Coral's own service user and every agent) is blocked from the cloud's metadata service (%s) and from the private network ranges (%s, %s); root and cloud-init are not.",
		egressMetadataV4, strings.Join(egressBlockedV4, ", "), strings.Join(egressBlockedV6, ", "))
}

// EgressRuleset is the nftables file: one table, one output chain, a reject for every non-root user's packets to the blocked ranges.
func EgressRuleset() string {
	return fmt.Sprintf(`# Coral machine: every non-root user is stopped from the cloud's metadata service and the private ranges (loopback is not listed, so local resolvers keep working).
table inet %s
delete table inet %s
table inet %s {
	chain output {
		type filter hook output priority %d; policy accept;
		meta skuid != 0 ip daddr { %s } counter reject with icmp type admin-prohibited
		meta skuid != 0 ip6 daddr { %s } counter reject with icmpv6 type admin-prohibited
	}
}
`, egressTableName, egressTableName, egressTableName, egressRulePrio, strings.Join(egressBlockedV4, ", "), strings.Join(egressBlockedV6, ", "))
}

// EgressUnit loads the rules before the network is configured and before Coral starts, and again at every boot. A failed load fails the unit, and so coral.service (which Requires it).
func EgressUnit() string {
	return fmt.Sprintf(`[Unit]
Description=Coral: block the metadata service and the private ranges for every non-root user
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target coral.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f %s
ExecStartPost=%s

[Install]
WantedBy=sysinit.target
`, egressRulesPath, egressCheckPath)
}

// EgressCheckScript runs after the load, as root: the table is there with both of its rules, and none of the machine's DNS resolvers is inside a blocked range. It says what is wrong on standard error (the journal).
func EgressCheckScript() string {
	return fmt.Sprintf(`#!/bin/sh
set -eu
rules=$(/usr/sbin/nft list table inet %[1]s)
[ "$(printf '%%s\n' "$rules" | grep -c 'meta skuid != 0')" -ge 2 ] || { echo "coral-egress: the egress rules are not loaded" >&2; exit 1; }
# a resolver inside a blocked range would make every lookup of a non-root user (Coral's own too) fail
resolvers=$(cat /run/systemd/resolve/resolv.conf /etc/resolv.conf 2>/dev/null | awk '$1 == "nameserver" { print $2 }' | grep -v '^127\.' | sort -u || true)
for ns in $resolvers; do
  case "$ns" in
    169.254.*|10.*|192.168.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|fe[89ab]*:*|fc*:*|fd*:*)
      echo "coral-egress: the DNS resolver $ns is inside a blocked range: lookups of every non-root user would fail" >&2; exit 1 ;;
  esac
done
`, egressTableName)
}

package machinelaunch

import (
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The ruleset blocks every range the ruling names, for every non-root user, in both families, and leaves loopback alone.
func TestEgressRulesetBlocksTheRangesForEveryNonRootUser(t *testing.T) {
	rules := EgressRuleset()
	for _, r := range []string{"169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fe80::/10", "fc00::/7"} {
		assert.Contains(t, rules, r)
	}
	assert.Equal(t, 2, strings.Count(rules, "meta skuid != 0"), "one rule per family, each by user id and not by program")
	assert.NotContains(t, rules, "skuid ==", "no allow-by-user: the scope is every non-root user")
	assert.NotRegexp(t, `127\.|::1`, rules, "loopback is not listed: systemd-resolved's 127.0.0.53 keeps working")
	assert.Contains(t, rules, "hook output")

	// the metadata address and a VPC address are inside what is blocked; a public address and loopback are not
	var blocked []netip.Prefix
	for _, p := range append(append([]string{}, egressBlockedV4...), egressBlockedV6...) {
		blocked = append(blocked, netip.MustParsePrefix(p))
	}
	inside := func(a string) bool {
		ip := netip.MustParseAddr(a)
		for _, p := range blocked {
			if p.Contains(ip) {
				return true
			}
		}
		return false
	}
	for _, a := range []string{"169.254.169.254", "10.116.0.2", "172.20.1.1", "192.168.0.9", "100.64.0.5", "fe80::1", "fd00::5"} {
		assert.True(t, inside(a), "%s is blocked", a)
	}
	for _, a := range []string{"8.8.8.8", "67.207.67.2", "127.0.0.53", "::1", "2001:4860:4860::8888"} {
		assert.False(t, inside(a), "%s is not blocked", a)
	}
}

// The unit loads before the network and before Coral, at every boot, and fails the unit (and so Coral, which Requires it) when the load or the check fails.
func TestEgressUnitIsOrderedBeforeTheNetworkAndCoral(t *testing.T) {
	u := EgressUnit()
	assert.Regexp(t, `(?m)^Before=network-pre\.target coral\.service$`, u)
	assert.Contains(t, u, "Wants=network-pre.target")
	assert.Contains(t, u, "DefaultDependencies=no")
	assert.Contains(t, u, "WantedBy=sysinit.target")
	assert.Contains(t, u, "ExecStart=/usr/sbin/nft -f /etc/coral/egress.nft")
	assert.Contains(t, u, "ExecStartPost=/usr/local/sbin/coral-egress-check")
	assert.Contains(t, u, "Type=oneshot")
}

// The confirm line says what is blocked and for whom.
func TestEgressSummaryNamesWhatAndWho(t *testing.T) {
	s := EgressSummary()
	for _, want := range []string{"every non-root user", "Coral's own service user", "metadata service (169.254.169.254)", "private network ranges", "root and cloud-init are not"} {
		assert.Contains(t, s, want)
	}
}

// The check script: it fails when a resolver is inside a blocked range and passes for a public one (run for real with a fake nft and a fake resolv.conf).
func TestEgressCheckScriptRefusesAResolverInABlockedRange(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	// a fake nft that lists the table with both rules
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "usr", "sbin"), 0o755))
	script := EgressCheckScript()
	script = strings.ReplaceAll(script, "/usr/sbin/nft", filepath.Join(dir, "usr", "sbin", "nft"))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "usr", "sbin", "nft"), []byte("#!/bin/sh\nprintf 'meta skuid != 0 ip daddr x reject\\nmeta skuid != 0 ip6 daddr y reject\\n'\n"), 0o755))
	run := func(resolvers string) (string, error) {
		resolv := filepath.Join(dir, "resolv.conf")
		require.NoError(t, os.WriteFile(resolv, []byte(resolvers), 0o644))
		s := strings.ReplaceAll(script, "/run/systemd/resolve/resolv.conf /etc/resolv.conf", resolv)
		path := filepath.Join(dir, "check.sh")
		require.NoError(t, os.WriteFile(path, []byte(s), 0o755))
		out, err := exec.Command("sh", path).CombinedOutput()
		return string(out), err
	}
	_, err := run("nameserver 127.0.0.53\nnameserver 67.207.67.2\nnameserver 67.207.67.3\n")
	assert.NoError(t, err, "public resolvers and the local stub pass")
	for _, bad := range []string{"10.116.0.2", "169.254.169.253", "172.17.0.2", "192.168.1.1", "100.100.0.1"} {
		out, err := run("nameserver " + bad + "\n")
		assert.Error(t, err, "resolver %s is inside a blocked range", bad)
		assert.Contains(t, out, "inside a blocked range")
	}
	out, err := run("nameserver 172.32.0.1\nnameserver 100.128.0.1\n")
	assert.NoError(t, err, "just outside 172.16/12 and 100.64/10 is public: %s", out)
}

// A real nft reads the ruleset (when one is installed here and may check without privileges): the syntax is right.
func TestEgressRulesetIsValidNftables(t *testing.T) {
	nft, err := exec.LookPath("nft")
	if err != nil {
		t.Skip("no nft on this machine")
	}
	f := filepath.Join(t.TempDir(), "egress.nft")
	require.NoError(t, os.WriteFile(f, []byte(EgressRuleset()), 0o600))
	out, err := exec.Command(nft, "-c", "-f", f).CombinedOutput()
	if err != nil && regexp.MustCompile(`(?i)operation not permitted|permission denied`).Match(out) {
		t.Skipf("nft cannot check without privileges here: %s", out)
	}
	assert.NoError(t, err, string(out))
}

package machinelaunch

import (
	"strings"
	"testing"
)

// The SSH source (Security's --allow-ssh-from ruling, #9934): a bare address is a /32 or /128, a CIDR is no wider than /24 (v4) or /48 (v6), and host bits, lists, hostnames and open ranges are refused.
func TestValidSSHSource(t *testing.T) {
	for in, want := range map[string]string{
		"9.9.9.9":                  "9.9.9.9",
		"9.9.9.9/32":               "9.9.9.9/32",
		"9.9.9.0/24":               "9.9.9.0/24",
		"9.9.9.128/25":             "9.9.9.128/25",
		"2606:4700:4700::1111":     "2606:4700:4700::1111",
		"2606:4700:4700::1111/128": "2606:4700:4700::1111/128",
		"2606:4700:4700::/48":      "2606:4700:4700::/48",
		"2606:4700:4700::/64":      "2606:4700:4700::/64",
	} {
		got, err := ValidSSHSource(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for name, in := range map[string]string{
		"empty": "", "/23": "9.9.8.0/23", "/16": "9.9.0.0/16", "/0": "0.0.0.0/0", "v6 /0": "::/0", "0.0.0.0": "0.0.0.0", "::": "::", "v6 /47": "2606:4700::/47", "v6 /32": "2606:4700::/32",
		"host bits": "9.9.9.5/24", "host bits v6": "2606:4700:4700::1/48", "list": "9.9.9.1,9.9.9.2", "spaces": "9.9.9.1 9.9.9.2", "semicolon": "9.9.9.9; reboot", "hostname": "example.com", "leading space": " 9.9.9.9",
		"port": "9.9.9.9:22", "zone": "fe80::1%eth0", "mapped": "::ffff:9.9.9.9", "bracketed": "[2606:4700:4700::1111]", "junk": "garbage", "bad prefix": "9.9.9.0/33", "negative": "9.9.9.0/-1", "too long": strings.Repeat("1", 70),
		"private /24": "10.0.0.0/24", "private": "192.168.1.1", "172": "172.16.0.0/24", "loopback": "127.0.0.1", "loopback v6": "::1", "link-local": "169.254.1.1", "link-local v6": "fe80::/64", "multicast": "224.0.0.1",
		"reserved doc": "203.0.113.0/24", "reserved doc 2": "198.51.100.7", "cgnat": "100.64.0.0/24", "ula": "fd00::/48", "v6 doc": "2001:db8::/48",
	} {
		if got, err := ValidSSHSource(in); err == nil {
			t.Errorf("%s: %q was accepted as %q", name, in, got)
		}
	}
}

// The structural check the firewall and the user-data make has the same floor and host-bit rules; it does not judge public or private, so documentation addresses in fixtures still pass.
func TestCanonicalSSHSourceKeepsTheFloorWithoutJudgingPublic(t *testing.T) {
	for _, ok := range []string{"203.0.113.9", "203.0.113.0/24", "2001:db8::/48"} {
		if _, err := canonicalSSHSource(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"0.0.0.0/0", "::/0", "203.0.112.0/23", "203.0.113.5/24", "2001:db8::/47", "203.0.113.9; reboot", "203.0.113.1,203.0.113.2"} {
		if got, err := canonicalSSHSource(bad); err == nil {
			t.Errorf("%q accepted as %q", bad, got)
		}
	}
	for _, bad := range []string{"0.0.0.0/0", "::/0", "203.0.112.0/23", "203.0.113.5/24"} {
		if _, err := firewallSource(bad); err == nil {
			t.Errorf("the firewall accepted %q", bad)
		}
	}
}

// The confirm names the rule exactly and how many addresses it opens.
func TestSSHRuleWords(t *testing.T) {
	for in, want := range map[string]string{
		"9.9.9.9": "9.9.9.9/32 (1 address)", "9.9.9.0/24": "9.9.9.0/24 (256 addresses)", "9.9.9.128/25": "9.9.9.128/25 (128 addresses)",
		"2606:4700:4700::1111": "2606:4700:4700::1111/128 (1 address)", "2606:4700:4700::/48": "2606:4700:4700::/48 (2^80 addresses)",
	} {
		if got := SSHRule(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

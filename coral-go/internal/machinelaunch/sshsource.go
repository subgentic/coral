package machinelaunch

import (
	"fmt"
	"net/netip"
	"strings"
)

// The SSH source address (Security's rulings iv and the --allow-ssh-from ruling, #9934). A launch opens SSH on the machine's cloud firewall to ONE source for the length of the setup, and what that source may be is
// decided here, in one place, for the command line, the user-data and the firewall alike.

const (
	maxSSHSourceWidth4 = 24 // the widest an IPv4 range may be: a /24
	maxSSHSourceWidth6 = 48 // the widest an IPv6 range may be: a /48
)

// reservedSourcePrefixes are ranges that are never a public source, over and above what net/netip names (private, loopback, link-local, multicast, unspecified).
var reservedSourcePrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"64:ff9b::/96", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
	} {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}()

// IsPublicSource is whether an address could be someone's public address: not private, loopback, link-local, multicast, unspecified or in a reserved range. An IPv4-mapped IPv6 address is judged as the IPv4 one.
func IsPublicSource(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() || !a.IsGlobalUnicast() {
		return false
	}
	for _, p := range reservedSourcePrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// parseSSHSource reads ONE address or ONE CIDR, strictly: no spaces, no list, no hostname, no zone, no port, no IPv4-mapped form, and no host bits set in a CIDR (refused, never masked). A bare address is a /32 or a /128.
func parseSSHSource(v string) (netip.Prefix, error) {
	if v == "" {
		return netip.Prefix{}, fmt.Errorf("the address the launcher reaches SSH from is needed (--allow-ssh-from)")
	}
	if strings.ContainsAny(v, " \t\r\n,;") || len(v) > 64 {
		return netip.Prefix{}, fmt.Errorf("the SSH source %q is not ONE address or ONE CIDR: give a single value such as 203.0.113.5 or 198.51.100.0/24", v)
	}
	bad := fmt.Errorf("the SSH source %q is not an IP address or a CIDR (no hostname, port or zone)", v)
	if !strings.Contains(v, "/") {
		a, err := netip.ParseAddr(v)
		if err != nil || a.Zone() != "" || a.Is4In6() {
			return netip.Prefix{}, bad
		}
		return netip.PrefixFrom(a, a.BitLen()), nil
	}
	p, err := netip.ParsePrefix(v)
	if err != nil || p.Addr().Zone() != "" || p.Addr().Is4In6() {
		return netip.Prefix{}, bad
	}
	if p != p.Masked() {
		return netip.Prefix{}, fmt.Errorf("the SSH source %q has host bits set: write it as %s, or name the one address", v, p.Masked())
	}
	return p, nil
}

// checkSSHSourceWidth refuses a source that is every address or wider than the floor, with the reason and a hint.
func checkSSHSourceWidth(v string, p netip.Prefix) error {
	if p.Addr().IsUnspecified() || p.Bits() == 0 {
		return fmt.Errorf("the SSH source %q would be every address: SSH is opened to one address or a narrow range, never the world; give your own address or a narrower range", v)
	}
	if limit := maxSSHSourceWidth4; p.Addr().Is4() && p.Bits() < limit {
		return fmt.Errorf("the SSH source %q is wider than a /%d: give a narrower range (a /%d or smaller) or your own address", v, limit, limit)
	}
	if limit := maxSSHSourceWidth6; p.Addr().Is6() && p.Bits() < limit {
		return fmt.Errorf("the SSH source %q is wider than a /%d: give a narrower range (a /%d or smaller) or your own address", v, limit, limit)
	}
	return nil
}

// canonicalSSHSource is the structural check the user-data and the firewall both make: one address or one CIDR, strictly read, not every address, not wider than the floor, no host bits. It returns the source in its
// canonical form (a bare address stays bare).
func canonicalSSHSource(v string) (string, error) {
	p, err := parseSSHSource(v)
	if err != nil {
		return "", err
	}
	if err := checkSSHSourceWidth(v, p); err != nil {
		return "", err
	}
	if !strings.Contains(v, "/") {
		return p.Addr().String(), nil
	}
	return p.String(), nil
}

// ValidSSHSource is what the command line checks for an explicit --allow-ssh-from, before anything is read or made: the structural check above, and the range must hold at least one public address (a range covering only
// private, loopback, link-local or reserved addresses could never be where this computer reaches the machine from). It returns the source canonical.
func ValidSSHSource(v string) (string, error) {
	c, err := canonicalSSHSource(v)
	if err != nil {
		return "", err
	}
	p, _ := parseSSHSource(c)
	if !IsPublicSource(p.Addr()) {
		return "", fmt.Errorf("the SSH source %q is not a public address or range (private, loopback, link-local and reserved addresses cannot reach the machine): give your public address or a narrower public range", v)
	}
	return c, nil
}

// SSHRule says exactly what the firewall opens, for the confirm: the address and prefix, and how many addresses that is.
func SSHRule(v string) string {
	p, err := parseSSHSource(v)
	if err != nil {
		return v
	}
	n := "1 address"
	if bits := p.Addr().BitLen() - p.Bits(); bits > 0 {
		if bits < 32 {
			n = fmt.Sprintf("%d addresses", uint64(1)<<uint(bits))
		} else {
			n = fmt.Sprintf("2^%d addresses", bits)
		}
	}
	return fmt.Sprintf("%s (%s)", p.String(), n)
}

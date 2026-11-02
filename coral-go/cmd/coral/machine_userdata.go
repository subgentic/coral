package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/machinelaunch"
)

// machineUserData makes the cloud-init user-data for one launch: the launch's public login key, the address SSH accepts, the Coral release to install, the cap the machine announces, the Hub it joins and the agent
// CLIs (claude@V, codex@V, pi@V, agy@sha256:...). It carries no Hub credential (#10917: that goes over SSH). It is the one seam between this command and the user-data builder (machinelaunch.BuildUserData); a test replaces it.
var machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, coralVersion string, digests machinelaunch.ReleaseDigests, hubURL string, agents []string) (string, error) {
	spec := machinelaunch.UserDataSpec{AllowSSHFrom: sshFrom, MaxMode: maxMode, CoralVersion: coralVersion, CoralDigests: digests, HubURL: hubURL, Agents: agents}
	if err := keys.FillUserData(&spec); err != nil {
		return "", err
	}
	return machinelaunch.BuildUserData(spec)
}

// newMachineBootstrap makes the bootstrapper that hands the machine its credential over SSH; a test replaces it.
var newMachineBootstrap = func() machinelaunch.Bootstrapper { return &machinelaunch.SSHBootstrap{} }

// publicIPEndpoint answers with this computer's public address as plain text over TLS (the address SSH on the machine is opened to, unless --allow-ssh-from names one).
var publicIPEndpoint = "https://api.ipify.org"

// publicIPHost is the host the lookup goes to, for the confirmation to name.
func publicIPHost() string {
	u, err := url.Parse(publicIPEndpoint)
	if err != nil {
		return publicIPEndpoint
	}
	return u.Host
}

// lookupClient and lookupTimeout are the lookup's HTTP client and its time limit; a test replaces them. The client follows NO redirect: an answer that is not a plain 200 from the endpoint itself is refused.
var (
	lookupClient  = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	lookupTimeout = 10 * time.Second
)

// lookupBodyMax is the most the answer may be (an address is at most 45 bytes): a longer body is refused, not cut.
const lookupBodyMax = 64

// reservedLookupPrefixes are address ranges that are never this computer's public address, over and above what net/netip names (private, loopback, link-local, multicast, unspecified).
var reservedLookupPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"64:ff9b::/96", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
	} {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}()

// parsePublicLookupAnswer is what the lookup's answer must be: ONE public IPv4 or IPv6 literal and nothing else (no CIDR, no zone, no port, no private, loopback, link-local, multicast, unspecified or reserved address). It
// returns the address in its canonical form, to be used as a single-address rule, never a range (Security's ruling, #9934).
func parsePublicLookupAnswer(body string) (string, error) {
	bad := fmt.Errorf("the lookup answered with something that is not one public address: pass --allow-ssh-from ADDRESS")
	a, err := netip.ParseAddr(strings.TrimSpace(body))
	if err != nil || a.Zone() != "" {
		return "", bad
	}
	a = a.Unmap()
	if a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() || !a.IsGlobalUnicast() {
		return "", bad
	}
	for _, p := range reservedLookupPrefixes {
		if p.Contains(a) {
			return "", bad
		}
	}
	return a.String(), nil
}

// detectSSHSource is the address SSH on the machine should accept: this computer's, asked of a third-party service over HTTPS (certificate checks as usual, no redirect, a short timeout, a size cap). Any failure or odd
// answer is a refusal that says to pass --allow-ssh-from; there is no fallback to opening SSH wider.
var detectSSHSource = func(ctx context.Context) (string, error) {
	fail := func(why string) (string, error) {
		return "", fmt.Errorf("could not find this computer's public address (%s): pass --allow-ssh-from ADDRESS", why)
	}
	u, err := url.Parse(publicIPEndpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fail("the lookup is not an https address")
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, publicIPEndpoint, nil)
	if err != nil {
		return fail("the lookup could not be made")
	}
	resp, err := lookupClient.Do(req)
	if err != nil {
		return fail("the lookup failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail(fmt.Sprintf("the lookup answered HTTP %d", resp.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, lookupBodyMax+1))
	if err != nil {
		return fail("the answer could not be read")
	}
	if len(b) > lookupBodyMax {
		return fail("the answer was too long")
	}
	return parsePublicLookupAnswer(string(b))
}

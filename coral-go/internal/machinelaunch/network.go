package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

// Network isolation (#10918, coral-hub's request 2): each launch makes its own VPC and its own cloud firewall, and removes them again with the machine. The firewall lets SSH in from the one address
// that is delivering the credential, for the length of the delivery, and nothing in afterwards; outbound is open (the ruling: Coral and the agents reach the Hub and the model providers), and the
// machine blocks its own non-root users from the metadata service and the private ranges (egress.go). A provider that cannot do this is refused, not skipped: a launch does not go on without it.

// VPC is a private network at a provider.
type VPC struct {
	ID     string
	Name   string
	Region string
}

// Firewall is a cloud firewall at a provider.
type Firewall struct {
	ID   string
	Name string
	Tag  string // the instances it applies to carry this tag
}

// FirewallSpec is what CreateFirewall is asked to make.
type FirewallSpec struct {
	Name    string
	Tag     string   // applies to instances with this tag (this launch's tag)
	SSHFrom []string // addresses (a.b.c.d or a.b.c.d/n) that may open port 22 inbound; none: nothing in
}

// Network is implemented by a provider that can make the per-launch isolation.
type Network interface {
	// CreateVPC makes a private network in a region. It is empty until an instance is made into it.
	CreateVPC(ctx context.Context, name, region string) (VPC, error)
	// DeleteVPC removes one. A VPC that still has a member answers ErrInUse until the member is gone.
	DeleteVPC(ctx context.Context, id string) error
	// CreateFirewall makes a firewall: inbound SSH from spec.SSHFrom only, outbound open, applied to the instances carrying spec.Tag.
	CreateFirewall(ctx context.Context, spec FirewallSpec) (Firewall, error)
	// CloseFirewall takes the inbound rule away: afterwards nothing is allowed in.
	CloseFirewall(ctx context.Context, fw Firewall) error
	// DeleteFirewall removes one.
	DeleteFirewall(ctx context.Context, id string) error
}

// NetworkLister is implemented by a provider that can list what this tool made (names start with VPCPrefix and FirewallPrefix), so a prune finds what a crashed launch left.
type NetworkLister interface {
	ListVPCs(ctx context.Context) ([]VPC, error)
	ListFirewalls(ctx context.Context) ([]Firewall, error)
}

// ErrInUse is a provider's answer to removing a network that still has a member.
var ErrInUse = errors.New("still in use")

// The names this tool gives what it makes: one per machine, so a machine's network is found again by its name when the state file is gone.
const (
	VPCPrefix      = "coral-vpc-"
	FirewallPrefix = "coral-fw-"
)

// VPCName and FirewallName are the names of a machine's VPC and firewall.
func VPCName(machine string) string      { return VPCPrefix + machine }
func FirewallName(machine string) string { return FirewallPrefix + machine }

// firewallSource checks an address the cloud firewall opens SSH to: the same one-address-or-prefix check the user-data builder makes (ValidSSHSource, which returns it canonical), and not a loopback,
// multicast or unspecified address, which could never be the one the credential is delivered from.
func firewallSource(s string) (string, error) {
	c, err := ValidSSHSource(s)
	if err != nil {
		return "", err
	}
	var p netip.Prefix
	if strings.Contains(c, "/") {
		p, err = netip.ParsePrefix(c)
	} else {
		var a netip.Addr
		if a, err = netip.ParseAddr(c); err == nil {
			p = netip.PrefixFrom(a, a.BitLen())
		}
	}
	if err != nil {
		return "", fmt.Errorf("%q is not an address or a prefix", s)
	}
	if p.Bits() == 0 {
		return "", fmt.Errorf("%q is every address: SSH is opened to one address, not to the world", s)
	}
	if a := p.Addr(); a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() {
		return "", fmt.Errorf("%q cannot be the address the credential is delivered from", s)
	}
	return c, nil
}

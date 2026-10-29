package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
)

// The pieces of a launch's isolation and of `coral machine delete|prune|list` (#10918). A launch calls CreateNetwork before it creates the instance, CloseDoor when the credential is delivered, and Teardown
// when anything fails; delete is Teardown with the Hub's revoke first and the state file kept current; prune finds what a crashed launch left, by tag, and asks before it removes anything.

// Net is the network a launch made: its VPC and its firewall.
type Net struct {
	VPC      VPC
	Firewall Firewall
}

// ErrNoNetwork is a provider that cannot make a VPC and a firewall: a launch is refused, not made without them.
var ErrNoNetwork = errors.New("this provider cannot make the isolated network a launch needs (a VPC and a firewall)")

// CreateNetwork makes the launch's VPC and its firewall (SSH in from sshFrom only, until CloseDoor; applied by launchTag). A firewall that fails removes the VPC it just made.
func CreateNetwork(ctx context.Context, p Provider, machine, region, launchTag string, sshFrom []string, out io.Writer) (*Net, error) {
	n, ok := p.(Network)
	if !ok {
		return nil, ErrNoNetwork
	}
	for _, s := range sshFrom {
		if _, err := firewallSource(s); err != nil {
			return nil, err
		}
	}
	vpc, err := n.CreateVPC(ctx, VPCName(machine), region)
	if err != nil {
		return nil, fmt.Errorf("could not make the machine's private network: %w", err)
	}
	fw, err := n.CreateFirewall(ctx, FirewallSpec{Name: FirewallName(machine), Tag: launchTag, SSHFrom: sshFrom})
	if err != nil {
		note := removeVPC(p, vpc.ID, 30*time.Second, 2*time.Second, out)
		return nil, fmt.Errorf("could not make the machine's firewall: %w%s", err, note)
	}
	fmt.Fprintf(out, "Made the machine's private network and firewall (SSH is open to %s only, until the credential is delivered).\n", strings.Join(sshFrom, ", "))
	return &Net{VPC: vpc, Firewall: fw}, nil
}

// CloseDoor takes the firewall's inbound rule away: afterwards nothing is allowed in.
func CloseDoor(ctx context.Context, p Provider, fw Firewall) error {
	n, ok := p.(Network)
	if !ok {
		return ErrNoNetwork
	}
	return n.CloseFirewall(ctx, fw)
}

func removeVPC(p Provider, id string, within, every time.Duration, out io.Writer) string {
	n, ok := p.(Network)
	if !ok {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), within+10*time.Second)
	defer cancel()
	deadline := time.Now().Add(within)
	for {
		err := n.DeleteVPC(ctx, id)
		switch {
		case err == nil || errors.Is(err, ErrNotFound):
			return "; its private network was removed"
		case errors.Is(err, ErrInUse) && time.Now().Before(deadline):
			time.Sleep(every) // the instance is being removed: a VPC with a member waits for it
		default:
			fmt.Fprintf(out, "Could not remove the private network %s: remove it yourself at %s.\n", id, p.Name())
			return fmt.Sprintf("; the private network %s could NOT be removed: remove it yourself at %s", id, p.Name())
		}
	}
}

// IDs are the pieces of one machine, by id, as a state record names them.
type IDs struct {
	DropletID, VPCID, FirewallID, SSHKeyID string
}

func (r Record) IDs() IDs {
	return IDs{DropletID: r.DropletID, VPCID: r.VPCID, FirewallID: r.FirewallID, SSHKeyID: r.SSHKeyID}
}

// Remaining is what Teardown could not remove.
type Remaining struct {
	IDs
	Errs []error
}

// Empty reports whether everything named was removed.
func (r Remaining) Empty() bool {
	return r.DropletID == "" && r.VPCID == "" && r.FirewallID == "" && r.SSHKeyID == ""
}

// Tuning is the waits of a teardown; tests shorten them.
type Tuning struct {
	VPCWait  time.Duration // how long a VPC that still has a member is retried (0 is 90 s)
	VPCEvery time.Duration // between tries (0 is 3 s)
}

func (t Tuning) vpcWait() time.Duration {
	if t.VPCWait > 0 {
		return t.VPCWait
	}
	return 90 * time.Second
}
func (t Tuning) vpcEvery() time.Duration {
	if t.VPCEvery > 0 {
		return t.VPCEvery
	}
	return 3 * time.Second
}

// Teardown removes what ids name, in the order the provider needs: the instance, then the firewall, then the VPC (which waits for the instance to leave), then the ssh key. Something already gone is fine.
// done is called with the ids still left after each step, so a state file keeps what a crash would otherwise lose. Each step is tried whatever the one before did.
func Teardown(ctx context.Context, p Provider, ids IDs, tune Tuning, out io.Writer, done func(IDs)) Remaining {
	left := ids
	var errs []error
	step := func(id string, what string, do func(context.Context, string) error, clear func(*IDs)) {
		if id == "" {
			return
		}
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if ctx.Err() == nil { // the caller's context may be the thing that ended: the clean-up has its own
			cctx, cancel = context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
		}
		err := do(cctx, id)
		if err == nil || errors.Is(err, ErrNotFound) {
			fmt.Fprintf(out, "Removed the machine's %s.\n", what)
			clear(&left)
			if done != nil {
				done(left)
			}
			return
		}
		errs = append(errs, fmt.Errorf("%s %s: %w", what, id, err))
		fmt.Fprintf(out, "Could not remove the machine's %s (%s): remove it yourself at %s.\n", what, id, p.Name())
	}
	step(ids.DropletID, "instance", p.Delete, func(i *IDs) { i.DropletID = "" })
	if n, ok := p.(Network); ok {
		step(ids.FirewallID, "firewall", n.DeleteFirewall, func(i *IDs) { i.FirewallID = "" })
		step(ids.VPCID, "private network", func(c context.Context, id string) error {
			deadline := time.Now().Add(tune.vpcWait())
			for {
				err := n.DeleteVPC(c, id)
				if errors.Is(err, ErrInUse) && time.Now().Before(deadline) && c.Err() == nil {
					time.Sleep(tune.vpcEvery())
					continue
				}
				return err
			}
		}, func(i *IDs) { i.VPCID = "" })
	} else if ids.FirewallID != "" || ids.VPCID != "" {
		errs = append(errs, ErrNoNetwork)
	}
	if k, ok := p.(KeyRemover); ok {
		step(ids.SSHKeyID, "ssh key", k.DeleteSSHKey, func(i *IDs) { i.SSHKeyID = "" })
	}
	return Remaining{IDs: left, Errs: errs}
}

// ManageDeps are what delete, prune and list use; tests give stubs.
type ManageDeps struct {
	Provider        Provider
	IdentityRevoker IdentityRevoker // nil: the machine's Hub identity is not revoked (no destroy credential was given)
	State           *State
	Out             io.Writer
	Confirm         func(summary string) (bool, error)
	Tune            Tuning
	Now             func() time.Time
	// ContinueIfRevokeFails destroys the machine even when its Hub identity could not be revoked (the person chose it): the failure is still said.
	ContinueIfRevokeFails bool
}

func (d ManageDeps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// ErrRevokeFailed is a delete that stopped because the Hub identity could not be revoked: nothing was destroyed.
var ErrRevokeFailed = errors.New("the machine's Hub identity could not be revoked, so nothing was destroyed")

// DeleteReport says what a delete did.
type DeleteReport struct {
	Name        string
	Revoked     bool
	RevokeNote  string // why the Hub identity was not revoked, when it was not
	Remaining   Remaining
	RecordGone  bool
	Found       bool
	Reconstruct bool // the ids came from the provider (no state record)
}

// Delete removes one machine: it revokes the machine's Hub identity first (when a destroy credential was given and the state file has the credential id), then removes the instance, firewall, VPC and ssh key
// the launch created, and the record. It can be run again: what is already gone is skipped, and the state file keeps what is left. A machine the state file does not know is found at the provider by its name and
// this tool's tag; its network is found by name.
func Delete(ctx context.Context, name string, d ManageDeps) (*DeleteReport, error) {
	if !nameShape.MatchString(name) {
		return nil, errors.New("the machine name must be 1 to 63 of a-z, 0-9 and hyphen, not starting with a hyphen")
	}
	rep := &DeleteReport{Name: name}
	rec, inState := d.State.Get(name)
	if !inState {
		var err error
		if rec, err = reconstruct(ctx, name, d.Provider); err != nil {
			return nil, err
		}
		rep.Reconstruct = true
	}
	if rec.DropletID == "" && rec.VPCID == "" && rec.FirewallID == "" && rec.SSHKeyID == "" {
		return nil, fmt.Errorf("no machine named %q (not in the state file, and %s has none with this tool's tag)", name, d.Provider.Name())
	}
	rep.Found = true

	switch {
	case d.IdentityRevoker == nil:
		rep.RevokeNote = "the machine's Hub identity was not revoked: no destroy credential was given (--hub-destroy-file); revoke it in Coral Hub"
	case rec.CredentialID == "":
		rep.RevokeNote = "the machine's Hub identity was not revoked: the state file has no credential id for it; revoke it in Coral Hub"
	default:
		if err := d.IdentityRevoker.Revoke(ctx, rec.CredentialID); err != nil {
			var re *IdentityRevokeError
			notFound := errors.As(err, &re) && re.Kind == RevokeNotFound
			if !notFound && !d.ContinueIfRevokeFails {
				return rep, fmt.Errorf("%w: %v", ErrRevokeFailed, err)
			}
			rep.RevokeNote = err.Error()
		} else {
			rep.Revoked = true
			fmt.Fprintln(d.Out, "Revoked the machine's Hub identity.")
		}
	}

	rep.Remaining = Teardown(ctx, d.Provider, rec.IDs(), d.Tune, d.Out, func(left IDs) {
		if !inState {
			return
		}
		rec.DropletID, rec.VPCID, rec.FirewallID, rec.SSHKeyID = left.DropletID, left.VPCID, left.FirewallID, left.SSHKeyID
		_ = d.State.Put(rec) // a step done is written down: a second run skips it
	})
	if rep.Remaining.Empty() && len(rep.Remaining.Errs) == 0 {
		if inState {
			if err := d.State.Remove(name); err != nil {
				return rep, err
			}
		}
		rep.RecordGone = true
	}
	if rep.RevokeNote != "" {
		fmt.Fprintln(d.Out, "Note: "+rep.RevokeNote+".")
	}
	if !rep.Remaining.Empty() || len(rep.Remaining.Errs) > 0 {
		return rep, fmt.Errorf("not everything was removed: %w", errors.Join(rep.Remaining.Errs...))
	}
	return rep, nil
}

// reconstruct finds a machine the state file does not know: its instance by name and this tool's tag, its VPC and firewall by the names this tool gives them.
func reconstruct(ctx context.Context, name string, p Provider) (Record, error) {
	rec := Record{Name: name, Provider: p.Name()}
	if l, ok := p.(Lister); ok {
		all, err := l.List(ctx)
		if err != nil {
			return rec, fmt.Errorf("could not list the machines at %s: %w", p.Name(), err)
		}
		for _, in := range all {
			if in.Name == name && slices.Contains(in.Tags, Tag) {
				rec.DropletID = in.ID
				break
			}
		}
	}
	if nl, ok := p.(NetworkLister); ok {
		if vpcs, err := nl.ListVPCs(ctx); err == nil {
			for _, v := range vpcs {
				if v.Name == VPCName(name) {
					rec.VPCID = v.ID
				}
			}
		}
		if fws, err := nl.ListFirewalls(ctx); err == nil {
			for _, f := range fws {
				if f.Name == FirewallName(name) {
					rec.FirewallID = f.ID
				}
			}
		}
	}
	return rec, nil
}

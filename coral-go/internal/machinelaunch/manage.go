package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
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
	rules := make([]string, len(sshFrom))
	for i, s := range sshFrom {
		rules[i] = SSHRule(s)
	}
	fmt.Fprintf(out, "Made the machine's private network and firewall (SSH is open to %s only, until the credential is delivered).\n", strings.Join(rules, ", "))
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
	DropletID, VPCID, FirewallID string
}

func (r Record) IDs() IDs {
	return IDs{DropletID: r.DropletID, VPCID: r.VPCID, FirewallID: r.FirewallID}
}

// Remaining is what Teardown could not remove.
type Remaining struct {
	IDs
	Errs []error
}

// Empty reports whether everything named was removed.
func (r Remaining) Empty() bool {
	return r.DropletID == "" && r.VPCID == "" && r.FirewallID == ""
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

// Teardown removes what ids name, in the order the provider needs: the instance, then the firewall, then the VPC (which waits for the instance to leave). An ssh key the person gave (--ssh-key) is theirs: it is never recorded and never deleted here. Something already gone is fine.
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
	return Remaining{IDs: left, Errs: errs}
}

// ManageDeps are what delete, prune and list use; tests give stubs.
type ManageDeps struct {
	Provider Provider
	Revoker  IdentityRevoker // nil: the machine's Hub identity is not revoked (no destroy credential was given)
	State    *State
	Out      io.Writer
	Confirm  func(summary string) (bool, error)
	Tune     Tuning
	Now      func() time.Time
	// ContinueIfRevokeFails destroys the machine even when its Hub identity could not be revoked (the person chose it): the failure is still said.
	ContinueIfRevokeFails bool
	// TypedID is the instance id the person typed (--id) for a machine the state file does not know: the only way to delete one.
	TypedID string
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
	if inState {
		var err error
		if rec, err = verifyRecordedDroplet(ctx, rec, d); err != nil { // re-read tag, name and launch tag before anything is revoked or deleted
			return rep, err
		}
	} else {
		var err error
		if rec, err = typedIDRecord(ctx, name, d); err != nil {
			return rep, err
		}
		rep.Reconstruct = true // the instance came from the provider, by the id the person typed
		fmt.Fprintf(d.Out, "Only the instance is removed: its firewall and private network (%s, %s), if they exist, are NOT touched; remove them by hand.\n", FirewallName(name), VPCName(name))
	}
	if rec.DropletID == "" && rec.VPCID == "" && rec.FirewallID == "" {
		return nil, fmt.Errorf("no machine named %q (not in the state file, and %s has none with this tool's tag)", name, d.Provider.Name())
	}
	rep.Found = true

	switch {
	case d.Revoker == nil:
		rep.RevokeNote = "the machine's Hub identity was not revoked: no destroy credential was given (--hub-destroy-file); revoke it in Coral Hub"
	case rec.CredentialID == "":
		rep.RevokeNote = "the machine's Hub identity was not revoked: the state file has no credential id for it; revoke it in Coral Hub"
	default:
		if err := d.Revoker.Revoke(ctx, rec.CredentialID); err != nil {
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
		rec.DropletID, rec.VPCID, rec.FirewallID = left.DropletID, left.VPCID, left.FirewallID
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

// launchTagOf is the launch tag an instance carries (the tag with this tool's launch prefix), or "".
func launchTagOf(in Instance) string {
	for _, t := range in.Tags {
		if strings.HasPrefix(t, "coral-launch-") {
			return t
		}
	}
	return ""
}

func describeInstance(in Instance) string {
	made := "unknown"
	if !in.Created.IsZero() {
		made = in.Created.UTC().Format(time.RFC3339)
	}
	return fmt.Sprintf("id %s, name %s, region %s, made %s, launch tag %s", in.ID, in.Name, in.Region, made, orNone(launchTagOf(in)))
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// listAll lists the provider's instances with this tool's tag, with the sweep's per-call limit.
func listAll(ctx context.Context, p Provider) ([]Instance, error) {
	l, ok := p.(Lister)
	if !ok {
		return nil, fmt.Errorf("%s cannot list the machines this tool made, so nothing can be re-read before a delete", p.Name())
	}
	cctx, cancel := context.WithTimeout(ctx, sweepCallTimeout)
	defer cancel()
	all, err := l.List(cctx)
	if err != nil {
		return nil, fmt.Errorf("could not list the machines at %s: %w", p.Name(), err)
	}
	return all, nil
}

// ErrDropletMismatch is a machine whose id is in the record but whose tag, name or launch tag at the provider is not what the record says: nothing is deleted.
var ErrDropletMismatch = errors.New("the machine at the provider is not the one the record says")

// ErrNeedTypedID is a delete for a machine the state file does not know: the person types the id.
var ErrNeedTypedID = errors.New("the state file does not know this machine")

// verifyRecordedDroplet re-reads the recorded droplet before anything is deleted (Security's rulings, #9934): it must still carry this tool's tag, the record's name AND the record's launch tag. A record with no droplet
// id (the create timed out before an id came back) finds a late droplet by the record's launch tag, and only a single one that matches. A droplet the provider no longer has is already gone.
func verifyRecordedDroplet(ctx context.Context, rec Record, d ManageDeps) (Record, error) {
	if rec.DropletID == "" && rec.LaunchTag == "" {
		return rec, nil
	}
	all, err := listAll(ctx, d.Provider)
	if err != nil {
		return rec, err
	}
	if rec.DropletID == "" { // a late droplet: found by the record's own launch tag
		var found []Instance
		for _, in := range all {
			if slices.Contains(in.Tags, Tag) && slices.Contains(in.Tags, rec.LaunchTag) {
				found = append(found, in)
			}
		}
		switch len(found) {
		case 0:
			return rec, nil
		case 1:
			rec.DropletID = found[0].ID
		default:
			for _, in := range found {
				fmt.Fprintf(d.Out, "Carries this launch's tag %s: %s.\n", rec.LaunchTag, describeInstance(in))
			}
			return rec, fmt.Errorf("%w: %d machines carry the launch tag %s, so none was deleted: check by hand", ErrDropletMismatch, len(found), rec.LaunchTag)
		}
	}
	for _, in := range all {
		if in.ID != rec.DropletID {
			continue
		}
		if !slices.Contains(in.Tags, Tag) || in.Name != rec.Name || (rec.LaunchTag != "" && !slices.Contains(in.Tags, rec.LaunchTag)) {
			fmt.Fprintf(d.Out, "At %s that id is: %s. The record says name %s, launch tag %s.\n", d.Provider.Name(), describeInstance(in), rec.Name, orNone(rec.LaunchTag))
			return rec, fmt.Errorf("%w: id %s was not deleted; check by hand", ErrDropletMismatch, rec.DropletID)
		}
		return rec, nil
	}
	rec.DropletID = "" // not at the provider any more: already gone
	return rec, nil
}

// typedIDRecord is the delete of a machine the state file does not know (Security's ruling ii): it lists the instances with this tool's tag and the name, shows them, and goes on ONLY with the one id the person typed. No id,
// an id that is not in the list, or a name that more than one machine carries: nothing is deleted. Only the instance is removed; its network, if any, is left (it cannot be told from another machine's by name alone).
func typedIDRecord(ctx context.Context, name string, d ManageDeps) (Record, error) {
	all, err := listAll(ctx, d.Provider)
	if err != nil {
		return Record{}, err
	}
	var cands []Instance
	for _, in := range all {
		if in.Name == name && slices.Contains(in.Tags, Tag) {
			cands = append(cands, in)
		}
	}
	if len(cands) == 0 {
		return Record{}, fmt.Errorf("no machine named %q (not in the state file, and %s has none with this tool's tag)", name, d.Provider.Name())
	}
	for _, in := range cands {
		fmt.Fprintf(d.Out, "At %s with this tool's tag and the name %s: %s.\n", d.Provider.Name(), name, describeInstance(in))
	}
	if d.TypedID == "" {
		return Record{}, fmt.Errorf("%w: nothing was deleted. To delete one of the machines listed, copy its id and run the same command with --id <id>", ErrNeedTypedID)
	}
	if len(cands) > 1 {
		return Record{}, fmt.Errorf("%d machines carry the name %q, so nothing was deleted: check by hand at %s", len(cands), name, d.Provider.Name())
	}
	if cands[0].ID != d.TypedID {
		return Record{}, fmt.Errorf("the id %q is not the machine listed above (%s), so nothing was deleted", d.TypedID, cands[0].ID)
	}
	return Record{Name: name, Provider: d.Provider.Name(), Region: cands[0].Region, DropletID: cands[0].ID}, nil
}

// ListUnknown is the read-only list of instances with this tool's tag that this state file does not know (by name or by launch tag): what another computer's launches, or a lost state file, look like. It deletes nothing.
func ListUnknown(ctx context.Context, d ManageDeps) ([]Instance, error) {
	all, err := listAll(ctx, d.Provider)
	if err != nil {
		return nil, err
	}
	tags := map[string]bool{}
	for _, r := range d.State.Records() {
		tags[r.LaunchTag] = true
	}
	var out []Instance
	for _, in := range all {
		if !slices.Contains(in.Tags, Tag) {
			continue
		}
		if _, known := d.State.Get(in.Name); known || tags[launchTagOf(in)] {
			continue
		}
		out = append(out, in)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

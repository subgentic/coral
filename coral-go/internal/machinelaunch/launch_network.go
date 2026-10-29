package machinelaunch

import (
	"context"
	"fmt"
	"io"
	"time"
)

// The launch's side of the isolation (#10918): the hooks Launch calls around the instance. They are here, apart from launch.go, so the launch's own flow stays as short to read as it is.

// credentialIDer is a Minter that remembers the id the Hub returned with a credential (not the credential): the state file keeps it so `coral machine delete` can revoke the machine's identity by it.
type credentialIDer interface {
	CredentialID(label string) string
}

// isolationWords is the part of the confirm that says what the isolation is: the private network, the firewall, and the block on the machine, and for whom.
func isolationWords(sshFrom string) string {
	return fmt.Sprintf("The machine gets its own private network and cloud firewall (SSH is open to %s only until the credential is delivered, then nothing is open inbound), both removed with the machine. %s",
		sshFromWords(sshFrom), EgressSummary())
}

// launchState keeps the ids of one launch in the state file as they come into being, so a crash at any point leaves a record `coral machine delete` can finish from. A nil state does nothing.
type launchState struct {
	st  *State
	rec Record
}

func newLaunchState(st *State, o Options, providerName, launchTag string) *launchState {
	return &launchState{st: st, rec: Record{Name: o.Name, Provider: providerName, Region: o.Region, LaunchTag: launchTag, Created: time.Now().UTC()}}
}

// set updates the record with f and writes it. A failure to write is said, not fatal: the launch's own clean-up does not depend on the file.
func (s *launchState) set(f func(*Record), out io.Writer) {
	if s == nil || s.st == nil {
		return
	}
	f(&s.rec)
	if err := s.st.Put(s.rec); err != nil {
		fmt.Fprintf(out, "Could not write the machine's ids to the state file (%v): `coral machine delete %s` will find the machine by its name and tag instead.\n", err, s.rec.Name)
	}
}

// drop removes the record once nothing is left at the provider.
func (s *launchState) drop() {
	if s != nil && s.st != nil {
		_ = s.st.Remove(s.rec.Name)
	}
}

// teardownLaunch removes what a failed launch made (the instance if there is one, the firewall, the VPC), in the provider's order, on its own deadline (the caller's context may be the thing that ended), and says
// how that went in a sentence for the error. A record is dropped only when everything is gone; otherwise it stays, naming what is left, for `coral machine delete`.
func teardownLaunch(p Provider, instanceID string, n *Net, ls *launchState, out io.Writer) string {
	ids := IDs{DropletID: instanceID}
	if n != nil {
		ids.FirewallID, ids.VPCID = n.Firewall.ID, n.VPC.ID
	}
	if n == nil {
		note := cleanup(p, instanceID, out) // no isolation was made: the instance only
		if ls != nil {
			ls.drop()
		}
		return note
	}
	left := Teardown(context.Background(), p, ids, Tuning{}, out, func(l IDs) {
		ls.set(func(r *Record) { r.DropletID, r.FirewallID, r.VPCID = l.DropletID, l.FirewallID, l.VPCID }, out)
	})
	if left.Empty() && len(left.Errs) == 0 {
		ls.drop()
		return "; the machine, its firewall and its private network this launch created were deleted"
	}
	name := ""
	if ls != nil {
		name = ls.rec.Name
	}
	return fmt.Sprintf("; NOT everything this launch created could be deleted: run `coral machine delete %s` to finish (it costs money while it exists)", name)
}

// teardownNetworkOnly removes the network of a launch whose Create failed (the instance, if one was made after all, is found and deleted by the tag clean-up first).
func teardownNetworkOnly(p Provider, n *Net, ls *launchState, out io.Writer) string {
	if n == nil {
		return ""
	}
	return teardownLaunch(p, "", n, ls, out)
}

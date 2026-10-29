package machinelaunch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCloud is a provider in memory: instances, VPCs, firewalls and keys, a log of every call in order, and failures on demand. No test here calls a real provider.
type fakeCloud struct {
	mu       sync.Mutex
	calls    []string
	drops    map[string]Instance // by id
	vpcs     map[string]VPC
	fws      map[string]Firewall
	keys     map[string]bool
	order    *[]string        // when set, every call is also logged here, to be read beside another recorder (the Hub's revoke)
	failOn   map[string]error // "DeleteFirewall:fw-1" -> error (once, then it works)
	vpcBusy  int              // DeleteVPC answers ErrInUse this many times first
	nextID   int
	hourly   float64
	priceErr error
}

func newFake() *fakeCloud {
	return &fakeCloud{drops: map[string]Instance{}, vpcs: map[string]VPC{}, fws: map[string]Firewall{}, keys: map[string]bool{}, failOn: map[string]error{}, hourly: 0.0119}
}

var (
	_ Provider      = (*fakeCloud)(nil)
	_ Lister        = (*fakeCloud)(nil)
	_ Network       = (*fakeCloud)(nil)
	_ NetworkLister = (*fakeCloud)(nil)
	_ KeyRemover    = (*fakeCloud)(nil)
)

func (f *fakeCloud) log(s string) {
	f.calls = append(f.calls, s)
	if f.order != nil {
		*f.order = append(*f.order, s)
	}
}
func (f *fakeCloud) fail(key string) error {
	if err, ok := f.failOn[key]; ok {
		delete(f.failOn, key)
		return err
	}
	return nil
}
func (f *fakeCloud) id(prefix string) string {
	f.nextID++
	return fmt.Sprintf("%s-%d", prefix, f.nextID)
}

func (f *fakeCloud) Name() string                   { return "fakecloud" }
func (f *fakeCloud) Validate(context.Context) error { return nil }
func (f *fakeCloud) Price(context.Context, string, string) (Price, error) {
	if f.priceErr != nil {
		return Price{}, f.priceErr
	}
	return Price{HourlyUSD: f.hourly, MonthlyUSD: f.hourly * 720}, nil
}
func (f *fakeCloud) Create(_ context.Context, s Spec) (Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("Create:" + s.Name)
	if err := f.fail("Create"); err != nil {
		return Instance{}, err
	}
	in := Instance{ID: fmt.Sprintf("%d", 1000+f.nextID), Name: s.Name, Status: StatusPending, Region: s.Region, Size: s.Size, Tags: append([]string{Tag}, s.Tags...), VPCID: s.VPCID, Created: time.Now()}
	f.nextID++
	f.drops[in.ID] = in
	return in, nil
}
func (f *fakeCloud) WaitRunning(_ context.Context, id string) (Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("WaitRunning:" + id)
	if err := f.fail("WaitRunning"); err != nil {
		return Instance{}, err
	}
	in := f.drops[id]
	in.Status, in.IPv4 = StatusRunning, "203.0.113.10"
	f.drops[id] = in
	return in, nil
}
func (f *fakeCloud) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("Delete:" + id)
	if err := f.fail("Delete:" + id); err != nil {
		return err
	}
	if _, ok := f.drops[id]; !ok {
		return ErrNotFound
	}
	delete(f.drops, id)
	return nil
}
func (f *fakeCloud) List(context.Context) ([]Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Instance
	for _, in := range f.drops {
		out = append(out, in)
	}
	return out, nil
}
func (f *fakeCloud) CreateVPC(_ context.Context, name, region string) (VPC, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("CreateVPC:" + name)
	if err := f.fail("CreateVPC"); err != nil {
		return VPC{}, err
	}
	v := VPC{ID: f.id("vpc"), Name: name, Region: region}
	f.vpcs[v.ID] = v
	return v, nil
}
func (f *fakeCloud) DeleteVPC(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("DeleteVPC:" + id)
	if f.vpcBusy > 0 {
		f.vpcBusy--
		return ErrInUse
	}
	if err := f.fail("DeleteVPC:" + id); err != nil {
		return err
	}
	if _, ok := f.vpcs[id]; !ok {
		return ErrNotFound
	}
	delete(f.vpcs, id)
	return nil
}
func (f *fakeCloud) CreateFirewall(_ context.Context, s FirewallSpec) (Firewall, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log(fmt.Sprintf("CreateFirewall:%s:ssh=%s", s.Name, strings.Join(s.SSHFrom, ",")))
	if err := f.fail("CreateFirewall"); err != nil {
		return Firewall{}, err
	}
	fw := Firewall{ID: f.id("fw"), Name: s.Name, Tag: s.Tag}
	f.fws[fw.ID] = fw
	return fw, nil
}
func (f *fakeCloud) CloseFirewall(_ context.Context, fw Firewall) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("CloseFirewall:" + fw.ID)
	return f.fail("CloseFirewall")
}
func (f *fakeCloud) DeleteFirewall(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("DeleteFirewall:" + id)
	if err := f.fail("DeleteFirewall:" + id); err != nil {
		return err
	}
	if _, ok := f.fws[id]; !ok {
		return ErrNotFound
	}
	delete(f.fws, id)
	return nil
}
func (f *fakeCloud) ListVPCs(context.Context) ([]VPC, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []VPC
	for _, v := range f.vpcs {
		out = append(out, v)
	}
	return out, nil
}
func (f *fakeCloud) ListFirewalls(context.Context) ([]Firewall, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Firewall
	for _, v := range f.fws {
		out = append(out, v)
	}
	return out, nil
}
func (f *fakeCloud) DeleteSSHKey(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("DeleteSSHKey:" + id)
	if err := f.fail("DeleteSSHKey"); err != nil {
		return err
	}
	if !f.keys[id] {
		return ErrNotFound
	}
	delete(f.keys, id)
	return nil
}

type fakeRevoker struct {
	log *[]string
	err error
	ids []string
}

func (r *fakeRevoker) Revoke(_ context.Context, id string) error {
	r.ids = append(r.ids, id)
	if r.log != nil {
		*r.log = append(*r.log, "Revoke:"+id)
	}
	return r.err
}

func quick() Tuning { return Tuning{VPCWait: 200 * time.Millisecond, VPCEvery: time.Millisecond} }

func stateAt(t *testing.T) *State {
	s, err := OpenState(filepath.Join(t.TempDir(), "machines.json"))
	require.NoError(t, err)
	return s
}

// ---- creating the network

func TestCreateNetworkMakesTheVPCThenTheFirewallWithTheLaunchTag(t *testing.T) {
	f := newFake()
	var out bytes.Buffer
	n, err := CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789ab", []string{"203.0.113.7/32"}, &out)
	require.NoError(t, err)
	assert.Equal(t, []string{"CreateVPC:coral-vpc-m1", "CreateFirewall:coral-fw-m1:ssh=203.0.113.7/32"}, f.calls, "the VPC first, then the firewall that allows SSH from the one address")
	assert.Equal(t, "coral-launch-0123456789ab", n.Firewall.Tag)
	assert.Contains(t, out.String(), "SSH is open to 203.0.113.7/32 only")
}

func TestCreateNetworkRemovesTheVPCWhenTheFirewallFails(t *testing.T) {
	f := newFake()
	f.failOn["CreateFirewall"] = errors.New("boom")
	_, err := CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789ab", []string{"203.0.113.7"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Empty(t, f.vpcs, "nothing is left behind")
	assert.Contains(t, err.Error(), "its private network was removed")
}

func TestCreateNetworkRefusesAProviderWithoutOneAndSSHToTheWorld(t *testing.T) {
	_, err := CreateNetwork(t.Context(), struct{ Provider }{newFake()}, "m1", "nyc3", "coral-launch-0123456789ab", []string{"203.0.113.7"}, &bytes.Buffer{})
	assert.ErrorIs(t, err, ErrNoNetwork, "a launch is refused, not made without the isolation")
	f := newFake()
	_, err = CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789ab", []string{"0.0.0.0/0"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Empty(t, f.calls, "nothing was made for SSH open to the world")
}

// ---- teardown

func TestTeardownRemovesTheInstanceFirstThenFirewallThenTheVPCThenTheKey(t *testing.T) {
	f := newFake()
	f.keys["k1"] = true
	f.drops["1"] = Instance{ID: "1", Name: "m1", Tags: []string{Tag}}
	f.fws["fw-1"], f.vpcs["vpc-1"] = Firewall{ID: "fw-1"}, VPC{ID: "vpc-1"}
	f.vpcBusy = 2 // the instance is still leaving: the VPC says so twice
	var progress []IDs
	left := Teardown(t.Context(), f, IDs{DropletID: "1", FirewallID: "fw-1", VPCID: "vpc-1", SSHKeyID: "k1"}, quick(), &bytes.Buffer{}, func(i IDs) { progress = append(progress, i) })
	assert.True(t, left.Empty())
	assert.Equal(t, []string{"Delete:1", "DeleteFirewall:fw-1", "DeleteVPC:vpc-1", "DeleteVPC:vpc-1", "DeleteVPC:vpc-1", "DeleteSSHKey:k1"}, f.calls, "instance, firewall, then the VPC (retried while it has a member), then the key")
	require.Len(t, progress, 4, "the ids still left are reported after each step, for the state file")
	assert.Equal(t, IDs{VPCID: "vpc-1", SSHKeyID: "k1", FirewallID: "fw-1"}, progress[0])
	assert.Equal(t, IDs{}, progress[3])
}

func TestTeardownTriesEveryStepWhateverTheOneBeforeDidAndReportsWhatIsLeft(t *testing.T) {
	f := newFake()
	f.drops["1"] = Instance{ID: "1", Tags: []string{Tag}}
	f.fws["fw-1"], f.vpcs["vpc-1"] = Firewall{ID: "fw-1"}, VPC{ID: "vpc-1"}
	f.failOn["DeleteFirewall:fw-1"] = errors.New("provider hiccup")
	var out bytes.Buffer
	left := Teardown(t.Context(), f, IDs{DropletID: "1", FirewallID: "fw-1", VPCID: "vpc-1"}, quick(), &out, nil)
	assert.Equal(t, "fw-1", left.FirewallID, "the firewall is what is left")
	assert.Empty(t, left.DropletID)
	assert.Empty(t, left.VPCID, "the VPC was still tried and removed")
	require.Len(t, left.Errs, 1)
	assert.Contains(t, out.String(), "remove it yourself at fakecloud")
	// things already gone are fine
	left = Teardown(t.Context(), f, IDs{DropletID: "1", FirewallID: "fw-1", VPCID: "vpc-1"}, quick(), &bytes.Buffer{}, nil)
	assert.True(t, left.Empty() && len(left.Errs) == 0)
}

// ---- delete

func record(name string, f *fakeCloud) Record {
	vpc, _ := f.CreateVPC(context.Background(), VPCName(name), "nyc3")
	fw, _ := f.CreateFirewall(context.Background(), FirewallSpec{Name: FirewallName(name), Tag: "coral-launch-0123456789ab"})
	f.drops["77"] = Instance{ID: "77", Name: name, Tags: []string{Tag, "coral-launch-0123456789ab"}, Region: "nyc3", Size: "s-1vcpu-1gb", Created: time.Now().Add(-72 * time.Hour)}
	f.keys["ab:cd"] = true
	f.calls = nil
	r := goodRecord(name)
	r.DropletID, r.VPCID, r.FirewallID, r.SSHKeyID = "77", vpc.ID, fw.ID, "ab:cd"
	return r
}

func TestDeleteRevokesTheHubIdentityBeforeItDestroysAnything(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	var order []string
	f.order = &order
	rev := &fakeRevoker{log: &order}
	rep, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, Revoker: rev, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.True(t, rep.Revoked)
	assert.Equal(t, []string{"Revoke:5b6c0f2e-0000-4000-8000-000000000001", "Delete:77", "DeleteFirewall:fw-2", "DeleteVPC:vpc-1", "DeleteSSHKey:ab:cd"}, order,
		"the Hub identity is revoked first (by the credential id the state file holds), then the instance, the firewall, the VPC and the key")
	assert.True(t, rep.RecordGone)
	_, ok := st.Get("m1")
	assert.False(t, ok, "the record is gone when everything is")
	assert.Empty(t, f.drops)
	assert.Empty(t, f.vpcs)
	assert.Empty(t, f.fws)
	assert.Empty(t, f.keys)
}

// A revoke that fails stops the delete before anything is destroyed (the machine could stay enrolled); the person can choose to go on.
func TestDeleteStopsWhenTheRevokeFailsUnlessTheyChooseToGoOn(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	rev := &fakeRevoker{err: &IdentityRevokeError{Kind: RevokeNotConfigured, Status: 503}}
	var out bytes.Buffer
	rep, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, Revoker: rev, State: st, Out: &out, Tune: quick()})
	require.ErrorIs(t, err, ErrRevokeFailed)
	assert.Contains(t, err.Error(), "NOT revoked")
	assert.Empty(t, f.calls, "nothing was destroyed")
	assert.False(t, rep.RecordGone)
	_, ok := st.Get("m1")
	assert.True(t, ok, "the record stays")

	rep, err = Delete(t.Context(), "m1", ManageDeps{Provider: f, Revoker: rev, State: st, Out: &out, Tune: quick(), ContinueIfRevokeFails: true})
	require.NoError(t, err)
	assert.False(t, rep.Revoked)
	assert.Contains(t, rep.RevokeNote, "NOT revoked", "and it says so")
	assert.Contains(t, out.String(), "Note:")
	assert.True(t, rep.RecordGone)
}

// A credential Coral Hub does not know (404) is said but does not block: there is nothing to revoke by this key.
func TestDeleteGoesOnWhenTheHubDoesNotKnowTheCredentialAndSaysWhenItWasNotAsked(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	rep, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, Revoker: &fakeRevoker{err: &IdentityRevokeError{Kind: RevokeNotFound, Status: 404}}, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Contains(t, strings.ToLower(rep.RevokeNote), "not revoked")

	f2 := newFake()
	st2 := stateAt(t)
	require.NoError(t, st2.Put(record("m2", f2)))
	rep, err = Delete(t.Context(), "m2", ManageDeps{Provider: f2, State: st2, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Contains(t, rep.RevokeNote, "--hub-destroy-file", "no destroy credential given: said plainly")
	assert.False(t, rep.Revoked)
}

// Idempotent: a delete that failed on one piece is run again and finishes; the state file kept what was left.
func TestDeleteCanBeRunAgainAndTheStateFileKeepsWhatIsLeft(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	r := record("m1", f)
	require.NoError(t, st.Put(r))
	f.failOn["DeleteFirewall:"+r.FirewallID] = errors.New("provider hiccup")
	rep, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.Error(t, err)
	assert.Equal(t, r.FirewallID, rep.Remaining.FirewallID)
	got, ok := st.Get("m1")
	require.True(t, ok, "the record stays while something is left")
	assert.Equal(t, r.FirewallID, got.FirewallID, "it names what is left")
	assert.Empty(t, got.DropletID, "and no longer what was removed")
	assert.Empty(t, got.VPCID)
	again, err := OpenState(st.path)
	require.NoError(t, err)
	g2, _ := again.Get("m1")
	assert.Equal(t, got, g2, "on disk too")

	f.calls = nil
	_, err = Delete(t.Context(), "m1", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Equal(t, []string{"DeleteFirewall:" + r.FirewallID}, f.calls, "only what was left is tried")
	_, ok = st.Get("m1")
	assert.False(t, ok)
	_, err = Delete(t.Context(), "m1", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	assert.Error(t, err, "a machine that is gone entirely is said so, not made up")
}

// With no state file, the machine is found at the provider by its name and the tool's tag, its network by the names this tool gives it.
func TestDeleteFindsAMachineTheStateFileLost(t *testing.T) {
	f := newFake()
	rec := record("m9", f)
	st := stateAt(t) // empty
	rep, err := Delete(t.Context(), "m9", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.True(t, rep.Reconstruct)
	assert.Empty(t, f.drops)
	assert.Empty(t, f.vpcs, "the VPC was found by its name %s", VPCName("m9"))
	assert.Empty(t, f.fws)
	assert.Contains(t, rep.RevokeNote, "--hub-destroy-file")
	_ = rec
	f2 := newFake()
	f2.drops["5"] = Instance{ID: "5", Name: "someone-elses", Tags: []string{"web"}}
	_, err = Delete(t.Context(), "someone-elses", ManageDeps{Provider: f2, State: stateAt(t), Out: &bytes.Buffer{}, Tune: quick()})
	require.Error(t, err, "a droplet without this tool's tag is never found, never deleted")
	assert.Len(t, f2.drops, 1)
}

// ---- list and prune

func TestListJoinsTheProviderWithTheStateFile(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	gone := goodRecord("m2")
	require.NoError(t, st.Put(gone))
	f.drops["88"] = Instance{ID: "88", Name: "stray", Tags: []string{Tag}, Region: "nyc3", Size: "s-1vcpu-1gb", Created: time.Now().Add(-5 * time.Hour), Status: StatusRunning}
	f.drops["99"] = Instance{ID: "99", Name: "not-ours", Tags: []string{"web"}}
	rows, err := List(t.Context(), ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}})
	require.NoError(t, err)
	byName := map[string]ListRow{}
	for _, r := range rows {
		byName[r.Name] = r
	}
	require.Len(t, rows, 3, "the tagged instances and the record whose instance is gone; nothing else")
	assert.True(t, byName["m1"].InState)
	assert.InDelta(t, 0.0119, byName["m1"].HourlyUSD, 1e-9)
	assert.InDelta(t, 72, byName["m1"].Age.Hours(), 0.1)
	assert.False(t, byName["stray"].InState)
	assert.True(t, byName["m2"].Gone)
	assert.NotContains(t, byName, "not-ours")
}

func TestPruneRemovesOnlyOldOrphansAfterOneConfirmation(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	f.vpcs["vpc-o"], f.fws["fw-o"] = VPC{ID: "vpc-o", Name: VPCName("orphan")}, Firewall{ID: "fw-o", Name: FirewallName("orphan")}
	f.drops["1"] = Instance{ID: "1", Name: "orphan", Tags: []string{Tag}, Created: time.Now().Add(-48 * time.Hour)}
	f.drops["2"] = Instance{ID: "2", Name: "fresh-orphan", Tags: []string{Tag}, Created: time.Now().Add(-1 * time.Hour)}
	f.drops["3"] = Instance{ID: "3", Name: "mine", Tags: []string{Tag}, Created: time.Now().Add(-90 * time.Hour)}
	f.drops["4"] = Instance{ID: "4", Name: "not-ours", Tags: []string{"web"}, Created: time.Now().Add(-900 * time.Hour)}
	mine := goodRecord("mine")
	mine.DropletID = "3"
	require.NoError(t, st.Put(mine))
	var asked []string
	d := ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(s string) (bool, error) { asked = append(asked, s); return false, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true}, d)
	assert.ErrorIs(t, err, ErrDeclined)
	require.Len(t, asked, 1, "one confirmation lists everything")
	assert.Contains(t, asked[0], "orphan:")
	assert.NotContains(t, asked[0], "mine", "a machine the state file knows is left alone")
	assert.NotContains(t, asked[0], "fresh-orphan", "newer than the age is left alone")
	assert.NotContains(t, asked[0], "not-ours", "nothing without this tool's tag is touched")
	assert.Contains(t, asked[0], "cannot revoke a machine's Hub identity")
	assert.Len(t, f.drops, 4, "declined: nothing was removed")
	assert.Len(t, rep.Items, 1)

	d.Confirm = func(string) (bool, error) { return true, nil }
	rep, err = Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true}, d)
	require.NoError(t, err)
	assert.Equal(t, []string{"orphan"}, rep.Removed)
	assert.NotContains(t, f.drops, "1")
	assert.Empty(t, f.vpcs, "its network went with it, found by name")
	assert.Empty(t, f.fws)
	assert.Len(t, f.drops, 3)

	_, err = Prune(t.Context(), PruneOptions{IncludeUnknown: true}, d)
	assert.Error(t, err, "an age is required")
	d.Confirm = nil
	f.drops["5"] = Instance{ID: "5", Name: "again", Tags: []string{Tag}, Created: time.Now().Add(-72 * time.Hour)}
	_, err = Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true}, d)
	assert.Error(t, err, "no one to ask and no --yes: nothing is removed")
	assert.Contains(t, f.drops, "5")
}

func TestPruneTakesStaleRecordsAndOrphanNetworksOnlyAsAsked(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	stale := goodRecord("stale")
	stale.Created = time.Now().Add(-200 * time.Hour)
	stale.DropletID = "gone"
	f.vpcs[stale.VPCID], f.fws[stale.FirewallID] = VPC{ID: stale.VPCID, Name: VPCName("stale")}, Firewall{ID: stale.FirewallID, Name: FirewallName("stale")}
	require.NoError(t, st.Put(stale))
	f.vpcs["vpc-lone"] = VPC{ID: "vpc-lone", Name: VPCName("lonely")}
	f.vpcs["vpc-team"] = VPC{ID: "vpc-team", Name: "the-teams-own"}
	d := ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(string) (bool, error) { return true, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true}, d)
	require.NoError(t, err)
	assert.Equal(t, []string{"stale"}, rep.Removed, "a record whose instance is gone, with its leftover network")
	_, ok := st.Get("stale")
	assert.False(t, ok)
	assert.Contains(t, f.vpcs, "vpc-lone", "an orphan network is not taken unless asked: it has no age")

	rep, err = Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true, IncludeNetworks: true}, d)
	require.NoError(t, err)
	assert.Equal(t, []string{"lonely"}, rep.Removed)
	assert.NotContains(t, f.vpcs, "vpc-lone")
	assert.Contains(t, f.vpcs, "vpc-team", "a VPC without this tool's name is never touched")
}

// SHOULD B (#10944): a machine with this tool's tag that THIS state file does not know is not taken unless the person says so: the tag proves this tool made it, not this state file.
func TestPruneLeavesUnknownTaggedMachinesAloneUnlessAsked(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	f.drops["1"] = Instance{ID: "1", Name: "someone-elses", Tags: []string{Tag}, Created: time.Now().Add(-300 * time.Hour)}
	var out bytes.Buffer
	asked := 0
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: func(string) (bool, error) { asked++; return true, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour}, d)
	require.NoError(t, err)
	assert.Empty(t, rep.Items, "not taken by default")
	assert.Zero(t, asked, "so there was nothing to confirm")
	assert.Contains(t, f.drops, "1", "and it is still there")
	assert.Contains(t, out.String(), "--include-unknown", "but it is said, with how to take it")
	assert.Contains(t, out.String(), "1 instance(s)")

	rep, err = Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour, IncludeUnknown: true}, d)
	require.NoError(t, err)
	assert.Equal(t, []string{"someone-elses"}, rep.Removed)
	assert.NotContains(t, f.drops, "1")
}

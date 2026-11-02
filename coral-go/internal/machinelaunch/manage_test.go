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
	mu        sync.Mutex
	calls     []string
	drops     map[string]Instance // by id
	vpcs      map[string]VPC
	fws       map[string]Firewall
	order     *[]string        // when set, every call is also logged here, to be read beside another recorder (the Hub's revoke)
	failOn    map[string]error // "DeleteFirewall:fw-1" -> error (once, then it works)
	vpcBusy   int              // DeleteVPC answers ErrInUse this many times first
	nextID    int
	hourly    float64
	priceErr  error
	hidden    map[string]bool // ids the tag-filtered List does not show (a droplet that lost its tag, or sits past the page limit) but Get still reads
	listTrunc bool            // List answers what it has with ErrListTruncated
}

func newFake() *fakeCloud {
	return &fakeCloud{drops: map[string]Instance{}, vpcs: map[string]VPC{}, fws: map[string]Firewall{}, failOn: map[string]error{}, hourly: 0.0119}
}

var (
	_ Provider      = (*fakeCloud)(nil)
	_ Lister        = (*fakeCloud)(nil)
	_ Getter        = (*fakeCloud)(nil)
	_ Network       = (*fakeCloud)(nil)
	_ NetworkLister = (*fakeCloud)(nil)
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
		if !f.hidden[in.ID] {
			out = append(out, in)
		}
	}
	if f.listTrunc {
		return out, ErrListTruncated
	}
	return out, nil
}

// Get reads one instance by id, hidden or not: not found when it is really gone.
func (f *fakeCloud) Get(_ context.Context, id string) (Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.fail("Get:" + id); err != nil {
		return Instance{}, err
	}
	in, ok := f.drops[id]
	if !ok {
		return Instance{}, ErrNotFound
	}
	return in, nil
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
	n, err := CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789abcdef0123456789abcdef", []string{"203.0.113.7/32"}, &out)
	require.NoError(t, err)
	assert.Equal(t, []string{"CreateVPC:coral-vpc-m1", "CreateFirewall:coral-fw-m1:ssh=203.0.113.7/32"}, f.calls, "the VPC first, then the firewall that allows SSH from the one address")
	assert.Equal(t, "coral-launch-0123456789abcdef0123456789abcdef", n.Firewall.Tag)
	assert.Contains(t, out.String(), "SSH is open to 203.0.113.7/32 (1 address) only, until the credential is delivered")
}

func TestCreateNetworkRemovesTheVPCWhenTheFirewallFails(t *testing.T) {
	f := newFake()
	f.failOn["CreateFirewall"] = errors.New("boom")
	_, err := CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789abcdef0123456789abcdef", []string{"203.0.113.7"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Empty(t, f.vpcs, "nothing is left behind")
	assert.Contains(t, err.Error(), "its private network was removed")
}

func TestCreateNetworkRefusesAProviderWithoutOneAndSSHToTheWorld(t *testing.T) {
	_, err := CreateNetwork(t.Context(), struct{ Provider }{newFake()}, "m1", "nyc3", "coral-launch-0123456789abcdef0123456789abcdef", []string{"203.0.113.7"}, &bytes.Buffer{})
	assert.ErrorIs(t, err, ErrNoNetwork, "a launch is refused, not made without the isolation")
	f := newFake()
	_, err = CreateNetwork(t.Context(), f, "m1", "nyc3", "coral-launch-0123456789abcdef0123456789abcdef", []string{"0.0.0.0/0"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Empty(t, f.calls, "nothing was made for SSH open to the world")
}

// ---- teardown

func TestTeardownRemovesTheInstanceFirstThenFirewallThenTheVPC(t *testing.T) {
	f := newFake()
	f.drops["1"] = Instance{ID: "1", Name: "m1", Tags: []string{Tag}}
	f.fws["fw-1"], f.vpcs["vpc-1"] = Firewall{ID: "fw-1"}, VPC{ID: "vpc-1"}
	f.vpcBusy = 2 // the instance is still leaving: the VPC says so twice
	var progress []IDs
	left := Teardown(t.Context(), f, IDs{DropletID: "1", FirewallID: "fw-1", VPCID: "vpc-1"}, quick(), &bytes.Buffer{}, func(i IDs) { progress = append(progress, i) })
	assert.True(t, left.Empty())
	assert.Equal(t, []string{"Delete:1", "DeleteFirewall:fw-1", "DeleteVPC:vpc-1", "DeleteVPC:vpc-1", "DeleteVPC:vpc-1"}, f.calls, "instance, firewall, then the VPC (retried while it has a member)")
	require.Len(t, progress, 3, "the ids still left are reported after each step, for the state file")
	assert.Equal(t, IDs{VPCID: "vpc-1", FirewallID: "fw-1"}, progress[0])
	assert.Equal(t, IDs{}, progress[2])
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
	fw, _ := f.CreateFirewall(context.Background(), FirewallSpec{Name: FirewallName(name), Tag: "coral-launch-0123456789abcdef0123456789abcdef"})
	f.drops["77"] = Instance{ID: "77", Name: name, Tags: []string{Tag, "coral-launch-0123456789abcdef0123456789abcdef"}, Region: "nyc3", Size: "s-1vcpu-1gb", Created: time.Now().Add(-72 * time.Hour)}
	f.calls = nil
	r := goodRecord(name)
	r.DropletID, r.VPCID, r.FirewallID = "77", vpc.ID, fw.ID
	return r
}

func TestDeleteRevokesTheHubIdentityBeforeItDestroysAnything(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	var order []string
	f.order = &order
	rev := &fakeRevoker{log: &order}
	rep, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, Revoker: rev, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.True(t, rep.Revoked)
	assert.Equal(t, []string{"Revoke:5b6c0f2e-0000-4000-8000-000000000001", "Delete:77", "DeleteFirewall:fw-2", "DeleteVPC:vpc-1"}, order,
		"the Hub identity is revoked first (by the credential id the state file holds), then the instance, the firewall and the VPC")
	assert.True(t, rep.RecordGone)
	_, ok := st.Get("m1")
	assert.False(t, ok, "the record is gone when everything is")
	assert.Empty(t, f.drops)
	assert.Empty(t, f.vpcs)
	assert.Empty(t, f.fws)
}

// A revoke that fails stops the delete before anything is destroyed (the machine could stay enrolled); the person can choose to go on.
func TestDeleteStopsWhenTheRevokeFailsUnlessTheyChooseToGoOn(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	rev := &fakeRevoker{err: &IdentityRevokeError{Kind: RevokeNotConfigured, Status: 503}}
	var out bytes.Buffer
	rep, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, Revoker: rev, State: st, Out: &out, Tune: quick()})
	require.ErrorIs(t, err, ErrRevokeFailed)
	assert.Contains(t, err.Error(), "NOT revoked")
	assert.Empty(t, f.calls, "nothing was destroyed")
	assert.False(t, rep.RecordGone)
	_, ok := st.Get("m1")
	assert.True(t, ok, "the record stays")

	rep, err = Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, Revoker: rev, State: st, Out: &out, Tune: quick(), ContinueIfRevokeFails: true})
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
	rep, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, Revoker: &fakeRevoker{err: &IdentityRevokeError{Kind: RevokeNotFound, Status: 404}}, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Contains(t, strings.ToLower(rep.RevokeNote), "not revoked")

	f2 := newFake()
	st2 := stateAt(t)
	require.NoError(t, st2.Put(record("m2", f2)))
	rep, err = Delete(t.Context(), "m2", ManageDeps{Confirm: yesConfirm, Provider: f2, State: st2, Out: &bytes.Buffer{}, Tune: quick()})
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
	rep, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
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
	_, err = Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Equal(t, []string{"DeleteFirewall:" + r.FirewallID}, f.calls, "only what was left is tried")
	_, ok = st.Get("m1")
	assert.False(t, ok)
	_, err = Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	assert.Error(t, err, "a machine that is gone entirely is said so, not made up")
}

// A machine the state file does not know is deleted ONLY by an id the person types (Security's ruling ii, #9934): no id lists the candidates and deletes nothing; an id outside the list, or a name two machines carry, deletes
// nothing; the right id deletes the instance alone and leaves its network.
func TestDeleteOfAMachineTheStateFileLostNeedsTheTypedID(t *testing.T) {
	f := newFake()
	record("m9", f)
	st := stateAt(t) // empty
	var out bytes.Buffer
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: yesConfirm}
	_, err := Delete(t.Context(), "m9", d)
	require.ErrorIs(t, err, ErrNeedTypedID)
	assert.Contains(t, out.String(), "id 77", "the candidate is listed")
	assert.Contains(t, err.Error(), "--id")
	assert.Len(t, f.drops, 1, "nothing was deleted")
	assert.NotContains(t, strings.Join(f.calls, ","), "Delete")

	d.TypedID = "99999"
	_, err = Delete(t.Context(), "m9", d)
	require.Error(t, err, "an id that is not in the list")
	assert.Len(t, f.drops, 1)

	f.drops["78"] = Instance{ID: "78", Name: "m9", Tags: []string{Tag}}
	d.TypedID = "77"
	_, err = Delete(t.Context(), "m9", d)
	require.Error(t, err, "two machines carry the name: nothing is deleted, even with a typed id")
	assert.Len(t, f.drops, 2)
	delete(f.drops, "78")

	d.TypedID = "77"
	rep, err := Delete(t.Context(), "m9", d)
	require.NoError(t, err)
	assert.True(t, rep.Reconstruct)
	assert.Empty(t, f.drops)
	assert.Len(t, f.vpcs, 1, "its network is NOT touched: it cannot be told from another machine's by name")
	assert.Len(t, f.fws, 1)
	assert.Contains(t, out.String(), "NOT touched")

	f2 := newFake()
	f2.drops["5"] = Instance{ID: "5", Name: "someone-elses", Tags: []string{"web"}}
	d2 := ManageDeps{Provider: f2, State: stateAt(t), Out: &bytes.Buffer{}, Tune: quick(), TypedID: "5"}
	_, err = Delete(t.Context(), "someone-elses", d2)
	require.Error(t, err, "a droplet without this tool's tag is never found, never deleted, even by typed id")
	assert.Len(t, f2.drops, 1)
}

// With a record, the droplet is re-read before anything is revoked or deleted: this tool's tag, the record's name and the record's launch tag must all still be on it.
func TestDeleteRereadsTheDropletAndRefusesAMismatch(t *testing.T) {
	for name, change := range map[string]func(*Instance){
		"tag removed":      func(i *Instance) { i.Tags = []string{"coral-launch-0123456789abcdef0123456789abcdef"} },
		"other name":       func(i *Instance) { i.Name = "someone-elses" },
		"other launch tag": func(i *Instance) { i.Tags = []string{Tag, "coral-launch-ffffffffffffffffffffffffffffffff"} },
		"no launch tag":    func(i *Instance) { i.Tags = []string{Tag} },
	} {
		f := newFake()
		st := stateAt(t)
		require.NoError(t, st.Put(record("m1", f)))
		in := f.drops["77"]
		change(&in)
		f.drops["77"] = in
		var order []string
		f.order = &order
		rev := &fakeRevoker{log: &order}
		var out bytes.Buffer
		_, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, Revoker: rev, State: st, Out: &out, Tune: quick()})
		require.ErrorIs(t, err, ErrDropletMismatch, name)
		assert.Empty(t, order, "%s: nothing was revoked or deleted", name)
		assert.Contains(t, f.drops, "77", name)
		assert.Contains(t, out.String(), "id 77", "%s: what was seen is printed", name)
		_, ok := st.Get("m1")
		assert.True(t, ok, "%s: the record stays", name)
	}
}

// A record whose droplet id never came back (the create timed out) finds a late droplet by the record's launch tag, re-reads it, and deletes that one; two refuse.
func TestDeleteFindsALateDropletByTheRecordsLaunchTag(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	r := record("m1", f)
	r.DropletID = ""
	require.NoError(t, st.Put(r))
	var out bytes.Buffer
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: yesConfirm}
	f.drops["88"] = Instance{ID: "88", Name: "m1", Tags: []string{Tag, r.LaunchTag}}
	delete(f.drops, "77")
	_, err := Delete(t.Context(), "m1", d)
	require.NoError(t, err)
	assert.NotContains(t, f.drops, "88", "the late droplet was found by the launch tag and deleted by its id")

	r2 := record("m2", f)
	r2.DropletID = ""
	require.NoError(t, st.Put(r2))
	f.drops["81"] = Instance{ID: "81", Name: "m2", Tags: []string{Tag, r2.LaunchTag}}
	f.drops["82"] = Instance{ID: "82", Name: "m2", Tags: []string{Tag, r2.LaunchTag}}
	_, err = Delete(t.Context(), "m2", d)
	require.ErrorIs(t, err, ErrDropletMismatch)
	assert.Contains(t, f.drops, "81")
	assert.Contains(t, f.drops, "82")
}

// A droplet the provider no longer has is already gone: the delete goes on to what is left.
func TestDeleteOfADropletAlreadyGoneStillRemovesTheNetwork(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	delete(f.drops, "77")
	_, err := Delete(t.Context(), "m1", ManageDeps{Confirm: yesConfirm, Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick()})
	require.NoError(t, err)
	assert.Empty(t, f.vpcs)
	assert.Empty(t, f.fws)
}

// ListUnknown is read-only and lists what this state file does not know, by name and by launch tag.
func TestListUnknownIsReadOnlyAndListsWhatTheStateFileDoesNot(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	f.drops["88"] = Instance{ID: "88", Name: "stray", Tags: []string{Tag, "coral-launch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, Region: "nyc3"}
	f.drops["99"] = Instance{ID: "99", Name: "not-ours", Tags: []string{"web"}}
	f.calls = nil
	odd, err := ListUnknown(t.Context(), ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}})
	require.NoError(t, err)
	require.Len(t, odd, 1)
	assert.Equal(t, "88", odd[0].ID)
	assert.Empty(t, f.calls, "no delete or any other call was made but the list")
	assert.Len(t, f.drops, 3)
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

// Prune never takes an instance the state file does not know, however old (Security's ruling iii, #9934): a second computer's launches look exactly like that. It is counted and said, with how to look at them.
func TestPruneNeverTakesAnInstanceTheStateFileDoesNotKnow(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	f.vpcs["vpc-o"], f.fws["fw-o"] = VPC{ID: "vpc-o", Name: VPCName("orphan")}, Firewall{ID: "fw-o", Name: FirewallName("orphan")}
	f.drops["1"] = Instance{ID: "1", Name: "orphan", Tags: []string{Tag}, Created: time.Now().Add(-48 * time.Hour)}
	f.drops["3"] = Instance{ID: "3", Name: "mine", Tags: []string{Tag}, Created: time.Now().Add(-90 * time.Hour)}
	f.drops["4"] = Instance{ID: "4", Name: "not-ours", Tags: []string{"web"}, Created: time.Now().Add(-900 * time.Hour)}
	mine := goodRecord("mine")
	mine.DropletID = "3"
	require.NoError(t, st.Put(mine))
	var out bytes.Buffer
	asked := 0
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: func(string) (bool, error) { asked++; return true, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour}, d)
	require.NoError(t, err)
	assert.Empty(t, rep.Items, "nothing the state file knows is stale, and the unknown instance is not taken")
	assert.Zero(t, asked)
	assert.Len(t, f.drops, 3, "nothing was removed")
	assert.Contains(t, f.vpcs, "vpc-o", "nor its network")
	assert.Contains(t, out.String(), "1 instance(s)")
	assert.Contains(t, out.String(), "list --unknown")
	assert.NotContains(t, out.String(), "include-unknown")
	_, err = Prune(t.Context(), PruneOptions{}, d)
	assert.Error(t, err, "an age is required")
}

// A network is an id, not a name (Security's ruling, #9934): a prune removes a network only with the RECORD that names its id, when a fresh read shows nothing in it. One that matches the tool's name but has no record is
// untouched and only listed; a recorded network that still has an instance in it stays.
func TestPruneRemovesOnlyRecordedNetworksAndOnlyEmptyOnes(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	stale := goodRecord("stale")
	stale.Created = time.Now().Add(-200 * time.Hour)
	stale.DropletID = "gone"
	f.vpcs[stale.VPCID], f.fws[stale.FirewallID] = VPC{ID: stale.VPCID, Name: VPCName("stale")}, Firewall{ID: stale.FirewallID, Name: FirewallName("stale")}
	require.NoError(t, st.Put(stale))
	// a second network with the SAME name as the recorded one but another id, and no record: another computer's
	f.vpcs["vpc-twin"], f.fws["fw-twin"] = VPC{ID: "vpc-twin", Name: VPCName("stale")}, Firewall{ID: "fw-twin", Name: FirewallName("stale")}
	f.vpcs["vpc-lone"] = VPC{ID: "vpc-lone", Name: VPCName("lonely")}
	f.vpcs["vpc-team"] = VPC{ID: "vpc-team", Name: "the-teams-own"}
	var out bytes.Buffer
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: func(string) (bool, error) { return true, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour}, d)
	require.NoError(t, err)
	assert.Equal(t, []string{"stale"}, rep.Removed, "a record whose instance is gone, with its recorded network")
	_, ok := st.Get("stale")
	assert.False(t, ok)
	assert.NotContains(t, f.vpcs, stale.VPCID)
	assert.NotContains(t, f.fws, stale.FirewallID)
	assert.Contains(t, f.vpcs, "vpc-twin", "a network with the same name and no record is untouched")
	assert.Contains(t, f.fws, "fw-twin")
	assert.Contains(t, f.vpcs, "vpc-lone")
	assert.Contains(t, f.vpcs, "vpc-team", "a VPC without this tool's name is never touched")

	// listed, never removed
	vpcs, fws, err := ListUnknownNetworks(t.Context(), d)
	require.NoError(t, err)
	var ids []string
	for _, v := range vpcs {
		ids = append(ids, v.ID)
	}
	assert.ElementsMatch(t, []string{"vpc-twin", "vpc-lone"}, ids)
	require.Len(t, fws, 1)
	assert.Equal(t, "fw-twin", fws[0].ID)
}

func TestPruneKeepsARecordedNetworkThatStillHasAnInstance(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	stale := goodRecord("stale")
	stale.Created = time.Now().Add(-200 * time.Hour)
	stale.DropletID = "gone"
	f.vpcs[stale.VPCID], f.fws[stale.FirewallID] = VPC{ID: stale.VPCID, Name: VPCName("stale")}, Firewall{ID: stale.FirewallID, Name: FirewallName("stale")}
	f.drops["500"] = Instance{ID: "500", Name: "member", Tags: []string{Tag}, VPCID: stale.VPCID, Created: time.Now().Add(-1 * time.Hour)}
	require.NoError(t, st.Put(stale))
	var out bytes.Buffer
	d := ManageDeps{Provider: f, State: st, Out: &out, Tune: quick(), Confirm: func(string) (bool, error) { return true, nil }}
	rep, err := Prune(t.Context(), PruneOptions{OlderThan: 24 * time.Hour}, d)
	require.NoError(t, err)
	assert.Empty(t, rep.Removed)
	assert.Contains(t, f.vpcs, stale.VPCID, "it has a member by the fresh read")
	assert.Contains(t, f.fws, stale.FirewallID)
	_, ok := st.Get("stale")
	assert.True(t, ok, "and the record stays")
	assert.Contains(t, out.String(), "still has an instance")
}

// The confirm is built from what was READ, and a read that does not match refuses before any prompt (Security's ruling, #9934).
func TestDeleteConfirmShowsWhatWasReadAndAMismatchNeverPrompts(t *testing.T) {
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	var asked []string
	d := ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(s string) (bool, error) { asked = append(asked, s); return true, nil }}
	in := f.drops["77"]
	in.Region, in.Size = "nyc3", "s-8vcpu-16gb"
	f.drops["77"] = in
	_, err := Delete(t.Context(), "m1", d)
	require.NoError(t, err)
	require.Len(t, asked, 1)
	for _, want := range []string{"id 77", "name m1", "region nyc3", "launch tag coral-launch-0123456789abcdef0123456789abcdef", "s-8vcpu-16gb", "made "} {
		assert.Contains(t, asked[0], want, "the prompt shows the read values")
	}

	f2 := newFake()
	st2 := stateAt(t)
	require.NoError(t, st2.Put(record("m1", f2)))
	changed := f2.drops["77"]
	changed.Region = "sfo3" // the droplet now differs from the record
	f2.drops["77"] = changed
	asked = nil
	d2 := ManageDeps{Provider: f2, State: st2, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(s string) (bool, error) { asked = append(asked, s); return true, nil }}
	_, err = Delete(t.Context(), "m1", d2)
	require.ErrorIs(t, err, ErrDropletMismatch)
	assert.Empty(t, asked, "refused before the prompt")
	assert.Contains(t, f2.drops, "77")

	d2.Confirm = func(string) (bool, error) { return false, nil }
	f3 := newFake()
	st3 := stateAt(t)
	require.NoError(t, st3.Put(record("m1", f3)))
	d2.Provider, d2.State = f3, st3
	_, err = Delete(t.Context(), "m1", d2)
	assert.ErrorIs(t, err, ErrDeleteDeclined)
	assert.Contains(t, f3.drops, "77", "declined: nothing deleted")
}

// A droplet missing from the tag-filtered list is NOT proof it is gone: only a direct read that says not found is. A droplet that lost its tag is refused; a list cut at the page limit refuses; a direct read that fails refuses.
func TestDeleteDoesNotTreatAMissingListEntryAsGone(t *testing.T) {
	for name, setup := range map[string]func(f *fakeCloud){
		"lost its tag, hidden from the list": func(f *fakeCloud) {
			in := f.drops["77"]
			in.Tags = []string{"coral-launch-0123456789abcdef0123456789abcdef"}
			f.drops["77"] = in
			f.hidden = map[string]bool{"77": true}
		},
		"list cut at the page limit": func(f *fakeCloud) { f.listTrunc = true },
		"direct read fails":          func(f *fakeCloud) { f.hidden = map[string]bool{"77": true}; f.failOn["Get:77"] = errors.New("down") },
	} {
		f := newFake()
		st := stateAt(t)
		require.NoError(t, st.Put(record("m1", f)))
		setup(f)
		f.calls = nil
		_, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(string) (bool, error) { return true, nil }})
		require.Error(t, err, name)
		assert.Empty(t, f.calls, "%s: nothing was deleted", name)
		assert.Len(t, f.fws, 1, "%s: the firewall stays", name)
		assert.Len(t, f.vpcs, 1, name)
		_, ok := st.Get("m1")
		assert.True(t, ok, "%s: the record stays", name)
	}
	// a direct read that says not found IS gone: the delete goes on to the firewall and the VPC
	f := newFake()
	st := stateAt(t)
	require.NoError(t, st.Put(record("m1", f)))
	delete(f.drops, "77")
	_, err := Delete(t.Context(), "m1", ManageDeps{Provider: f, State: st, Out: &bytes.Buffer{}, Tune: quick(), Confirm: func(string) (bool, error) { return true, nil }})
	require.NoError(t, err)
	assert.Empty(t, f.fws)
	assert.Empty(t, f.vpcs)
}

// yesConfirm answers a delete's confirm with yes: the tests that are not about the prompt.
func yesConfirm(string) (bool, error) { return true, nil }

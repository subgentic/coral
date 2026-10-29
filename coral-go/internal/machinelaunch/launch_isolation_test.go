package machinelaunch

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10918: a launch makes its own VPC and firewall before the machine, puts the machine in them, closes the firewall when the credential is delivered, and removes everything on a failure.

// isoProvider is the launch tests' stub provider with the network, in the order of every call.
type isoProvider struct {
	*stubProvider
	cloud *fakeCloud
	order []string
}

func newIso() *isoProvider {
	p := &isoProvider{stubProvider: &stubProvider{}, cloud: newFake()}
	p.cloud.order = &p.order
	return p
}

func (p *isoProvider) Create(ctx context.Context, s Spec) (Instance, error) {
	p.order = append(p.order, "create:vpc="+s.VPCID)
	return p.stubProvider.Create(ctx, s)
}
func (p *isoProvider) WaitRunning(ctx context.Context, id string) (Instance, error) {
	p.order = append(p.order, "wait")
	return p.stubProvider.WaitRunning(ctx, id)
}
func (p *isoProvider) Delete(ctx context.Context, id string) error {
	p.order = append(p.order, "delete:"+id)
	return p.stubProvider.Delete(ctx, id)
}
func (p *isoProvider) CreateVPC(ctx context.Context, n, r string) (VPC, error) {
	return p.cloud.CreateVPC(ctx, n, r)
}
func (p *isoProvider) DeleteVPC(ctx context.Context, id string) error {
	return p.cloud.DeleteVPC(ctx, id)
}
func (p *isoProvider) CreateFirewall(ctx context.Context, s FirewallSpec) (Firewall, error) {
	return p.cloud.CreateFirewall(ctx, s)
}
func (p *isoProvider) CloseFirewall(ctx context.Context, fw Firewall) error {
	return p.cloud.CloseFirewall(ctx, fw)
}
func (p *isoProvider) DeleteFirewall(ctx context.Context, id string) error {
	return p.cloud.DeleteFirewall(ctx, id)
}

var _ Network = (*isoProvider)(nil)

// idHub is the stub Hub that also remembers the credential id the Hub returned.
type idHub struct {
	*stubHub
	id string
}

func (h idHub) CredentialID(string) string { return h.id }

func isoSetup(t *testing.T, p *isoProvider, h *stubHub) (Options, Deps, *State, interface{ String() string }) {
	o, d, out, _ := setupWith(t, p.stubProvider, h)
	d.Provider = p
	d.Isolate = true
	st, err := OpenState(filepath.Join(t.TempDir(), "machines.json"))
	require.NoError(t, err)
	d.State = st
	return o, d, st, out
}

func TestLaunchMakesTheNetworkFirstThenTheMachineInItAndClosesTheDoorAfterTheCredential(t *testing.T) {
	p, h := newIso(), &stubHub{}
	o, d, st, out := isoSetup(t, p, h)
	d.Hub = idHub{h, "5b6c0f2e-0000-4000-8000-000000000001"}
	var confirm string
	d.Confirm = func(s string) (bool, error) { confirm = s; return true, nil }
	res, err := Launch(t.Context(), o, d)
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, []string{
		"CreateVPC:coral-vpc-coral-1",
		"CreateFirewall:coral-fw-coral-1:ssh=203.0.113.9",
		"create:vpc=vpc-1",
		"wait",
		"CloseFirewall:fw-2",
	}, p.order, "the VPC, the firewall, the machine inside the VPC, the wait, and the firewall closed once the credential was delivered")
	assert.Equal(t, "vpc-1", p.stubProvider.spec.VPCID)
	assert.Contains(t, p.stubProvider.spec.Tags[1], "coral-launch-", "the firewall applies by this launch's tag")
	assert.Equal(t, p.stubProvider.spec.Tags[1], p.cloud.fws["fw-2"].Tag)

	rec, ok := st.Get("coral-1")
	require.True(t, ok, "the ids are in the state file, for delete")
	assert.Equal(t, "42", rec.DropletID)
	assert.Equal(t, "vpc-1", rec.VPCID)
	assert.Equal(t, "fw-2", rec.FirewallID)
	assert.Equal(t, "5b6c0f2e-0000-4000-8000-000000000001", rec.CredentialID, "the credential's id, not the credential")
	assert.NotContains(t, rec.CredentialID, "chb_")
	assert.Contains(t, out.String(), "Closed the cloud firewall")
	assert.Contains(t, confirm, "every non-root user", "the confirm says what is blocked and for whom")
	assert.Contains(t, confirm, "169.254.169.254")
	assert.Contains(t, confirm, "its own private network and cloud firewall")
}

// A failure at any step after the network was made leaves nothing: no machine, no firewall, no VPC, no record.
func TestLaunchThatFailsLeavesNothingBehind(t *testing.T) {
	for name, set := range map[string]func(p *isoProvider, h *stubHub){
		"the machine never runs": func(p *isoProvider, h *stubHub) { p.stubProvider.waitErr = errors.New("never") },
		"the create fails":       func(p *isoProvider, h *stubHub) { p.stubProvider.createErr = errors.New("quota") },
		"the Hub will not mint":  func(p *isoProvider, h *stubHub) { h.err = errors.New("hub says no") },
	} {
		p, h := newIso(), &stubHub{}
		set(p, h)
		o, d, st, out := isoSetup(t, p, h)
		_, err := Launch(t.Context(), o, d)
		require.Error(t, err, name)
		assert.Empty(t, p.cloud.vpcs, "%s: no VPC is left", name)
		assert.Empty(t, p.cloud.fws, "%s: no firewall is left", name)
		assert.Empty(t, st.Records(), "%s: and no record", name)
		assert.NotContains(t, p.order, "CloseFirewall:fw-2", "%s: the door was never closed, because it was never opened this far", name)
		_ = out
	}
	// the machine's delete comes before the firewall's and the VPC's
	p, h := newIso(), &stubHub{}
	p.stubProvider.waitErr = errors.New("never")
	o, d, _, _ := isoSetup(t, p, h)
	_, err := Launch(t.Context(), o, d)
	require.Error(t, err)
	assert.Equal(t, []string{"CreateVPC:coral-vpc-coral-1", "CreateFirewall:coral-fw-coral-1:ssh=203.0.113.9", "create:vpc=vpc-1", "wait", "delete:42", "DeleteFirewall:fw-2", "DeleteVPC:vpc-1"}, p.order,
		"the instance first, then the firewall, then the VPC")
	assert.Contains(t, err.Error(), "its firewall and its private network this launch created were deleted")
}

// A piece that cannot be removed is said, with the command to finish, and the record stays with what is left.
func TestLaunchThatCannotRemoveEverythingSaysSoAndKeepsTheRecord(t *testing.T) {
	p, h := newIso(), &stubHub{}
	p.stubProvider.waitErr = errors.New("never")
	p.cloud.failOn["DeleteFirewall:fw-2"] = errors.New("provider hiccup")
	o, d, st, _ := isoSetup(t, p, h)
	_, err := Launch(t.Context(), o, d)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "NOT everything")
	assert.Contains(t, err.Error(), "coral machine delete coral-1")
	rec, ok := st.Get("coral-1")
	require.True(t, ok)
	assert.Equal(t, "fw-2", rec.FirewallID, "the record names what is left")
	assert.Empty(t, rec.DropletID)
	assert.Empty(t, rec.VPCID)
}

// A provider that cannot isolate is refused before anything is made: the launch does not go on without it.
func TestLaunchRefusesAProviderThatCannotIsolate(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, _ := setupWith(t, p, h)
	d.Isolate = true
	_, err := Launch(t.Context(), o, d)
	require.ErrorIs(t, err, ErrNoNetwork)
	assert.NotContains(t, strings.Join(p.calls, ","), "create", "no machine was made")
	assert.Empty(t, h.labels, "and nothing was minted")
}

// A firewall that will not close is a warning, not a failure: the machine closes its own SSH, and the person is told what to do.
func TestLaunchWarnsWhenTheFirewallWillNotClose(t *testing.T) {
	p, h := newIso(), &stubHub{}
	p.cloud.failOn["CloseFirewall"] = errors.New("provider hiccup")
	o, d, _, out := isoSetup(t, p, h)
	res, err := Launch(t.Context(), o, d)
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Contains(t, out.String(), "WARNING: could not close the cloud firewall")
	assert.Contains(t, out.String(), "coral machine delete coral-1")
}

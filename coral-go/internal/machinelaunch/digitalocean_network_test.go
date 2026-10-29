package machinelaunch

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10918: the per-launch VPC and cloud firewall, against a stub server. No real call is made.

const (
	vpcUUID = "11111111-2222-3333-4444-555555555555"
	fwUUID  = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
)

func TestCreateVPCSendsItsNameAndRegionAndReturnsItsId(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, http.StatusCreated, map[string]any{"vpc": map[string]any{"id": vpcUUID, "name": "coral-vpc-m1", "region": "nyc3"}})
	})
	v, err := d.CreateVPC(t.Context(), "coral-vpc-m1", "nyc3")
	require.NoError(t, err)
	assert.Equal(t, VPC{ID: vpcUUID, Name: "coral-vpc-m1", Region: "nyc3"}, v)
	require.Len(t, s.requests, 1)
	assert.Equal(t, "POST", s.requests[0].Method)
	assert.Equal(t, "/vpcs", s.requests[0].Path)
	var got map[string]any
	require.NoError(t, json.Unmarshal(s.requests[0].Body, &got))
	assert.Equal(t, "coral-vpc-m1", got["name"])
	assert.Equal(t, "nyc3", got["region"])
	assert.NotContains(t, got, "ip_range", "the provider picks the range")

	for _, bad := range [][2]string{{"mine", "nyc3"}, {"coral-vpc-x", "NYC 3"}, {"coral-vpc-" + string(make([]byte, 300)), "nyc3"}} {
		_, err := d.CreateVPC(t.Context(), bad[0], bad[1])
		assert.Error(t, err, "%q %q is not sent", bad[0], bad[1])
	}
	assert.Len(t, s.requests, 1, "nothing was sent for a name this tool does not make")
}

func TestDeleteVPCTellsInUseFromGone(t *testing.T) {
	status, msg := http.StatusConflict, "Can not delete VPC with members"
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, status, map[string]any{"id": "conflict", "message": msg})
	})
	assert.ErrorIs(t, d.DeleteVPC(t.Context(), vpcUUID), ErrInUse)
	status, msg = http.StatusNotFound, "not found"
	assert.ErrorIs(t, d.DeleteVPC(t.Context(), vpcUUID), ErrNotFound)
	status = http.StatusNoContent
	assert.NoError(t, d.DeleteVPC(t.Context(), vpcUUID))
	assert.Error(t, d.DeleteVPC(t.Context(), "../../droplets/1"), "an id that is not a VPC id is not put into a path")
}

// The firewall: inbound SSH from the given addresses only, outbound open, applied by the launch's tag.
func TestCreateFirewallAllowsSSHFromOneAddressAndNothingElseInbound(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, http.StatusAccepted, map[string]any{"firewall": map[string]any{"id": fwUUID, "name": "coral-fw-m1", "tags": []string{"coral-launch-abc"}}})
	})
	fw, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: "coral-launch-abc", SSHFrom: []string{"203.0.113.7/32"}})
	require.NoError(t, err)
	assert.Equal(t, Firewall{ID: fwUUID, Name: "coral-fw-m1", Tag: "coral-launch-abc"}, fw)
	var got struct {
		Name    string   `json:"name"`
		Tags    []string `json:"tags"`
		Inbound []struct {
			Protocol string `json:"protocol"`
			Ports    string `json:"ports"`
			Sources  struct {
				Addresses []string `json:"addresses"`
			} `json:"sources"`
		} `json:"inbound_rules"`
		Outbound []map[string]any `json:"outbound_rules"`
	}
	require.NoError(t, json.Unmarshal(s.requests[0].Body, &got))
	assert.Equal(t, "POST", s.requests[0].Method)
	assert.Equal(t, "/firewalls", s.requests[0].Path)
	assert.Equal(t, []string{"coral-launch-abc"}, got.Tags)
	require.Len(t, got.Inbound, 1, "one inbound rule")
	assert.Equal(t, "tcp", got.Inbound[0].Protocol)
	assert.Equal(t, "22", got.Inbound[0].Ports, "SSH only")
	assert.Equal(t, []string{"203.0.113.7/32"}, got.Inbound[0].Sources.Addresses, "from the launching address only")
	assert.Len(t, got.Outbound, 3, "tcp, udp and icmp out: a firewall with no outbound rule allows none")
}

// Refused before anything is sent: SSH to the world, a bad address, a name that is not this tool's.
func TestCreateFirewallRefusesTheWorldAndBadInput(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) { writeJSON(w, 200, map[string]any{}) })
	for _, from := range []string{"0.0.0.0/0", "::/0", "not-an-address", "127.0.0.1", "224.0.0.1", "10.0.0.1/33"} {
		_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: "coral-launch-abc", SSHFrom: []string{from}})
		assert.Error(t, err, "SSH source %q", from)
	}
	_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "other-fw", Tag: "coral-launch-abc"})
	assert.Error(t, err, "a firewall this tool does not name")
	_, err = d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: "bad tag"})
	assert.Error(t, err)
	assert.Empty(t, s.requests, "nothing was sent")
}

// Closing replaces the firewall with the same one that has no inbound rule.
func TestCloseFirewallLeavesNothingInbound(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, 200, map[string]any{"firewall": map[string]any{"id": fwUUID}})
	})
	require.NoError(t, d.CloseFirewall(t.Context(), Firewall{ID: fwUUID, Name: "coral-fw-m1", Tag: "coral-launch-abc"}))
	require.Len(t, s.requests, 1)
	assert.Equal(t, "PUT", s.requests[0].Method)
	assert.Equal(t, "/firewalls/"+fwUUID, s.requests[0].Path)
	var got struct {
		Inbound  []any            `json:"inbound_rules"`
		Outbound []map[string]any `json:"outbound_rules"`
		Tags     []string         `json:"tags"`
	}
	require.NoError(t, json.Unmarshal(s.requests[0].Body, &got))
	assert.Empty(t, got.Inbound, "nothing in")
	assert.Len(t, got.Outbound, 3, "outbound stays open")
	assert.Equal(t, []string{"coral-launch-abc"}, got.Tags, "and it still applies to the machine")
	assert.Error(t, d.CloseFirewall(t.Context(), Firewall{ID: "x/../y", Name: "coral-fw-m1", Tag: "t"}))
}

func TestListVPCsAndFirewallsKeepOnlyWhatThisToolMade(t *testing.T) {
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		switch r.URL.Path {
		case "/vpcs":
			writeJSON(w, 200, map[string]any{"vpcs": []map[string]any{
				{"id": vpcUUID, "name": "coral-vpc-m1", "region": "nyc3"}, {"id": "99999999-2222-3333-4444-555555555555", "name": "the-teams-own-vpc", "region": "nyc3"}}})
		case "/firewalls":
			writeJSON(w, 200, map[string]any{"firewalls": []map[string]any{
				{"id": fwUUID, "name": "coral-fw-m1", "tags": []string{"coral-launch-abc"}}, {"id": "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", "name": "web", "tags": []string{"web"}}}})
		}
	})
	vpcs, err := d.ListVPCs(t.Context())
	require.NoError(t, err)
	assert.Equal(t, []VPC{{ID: vpcUUID, Name: "coral-vpc-m1", Region: "nyc3"}}, vpcs, "the account's other VPCs are never listed")
	fws, err := d.ListFirewalls(t.Context())
	require.NoError(t, err)
	assert.Equal(t, []Firewall{{ID: fwUUID, Name: "coral-fw-m1", Tag: "coral-launch-abc"}}, fws)
}

func TestCreateMakesTheDropletInTheVPC(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, http.StatusAccepted, map[string]any{"droplet": map[string]any{"id": 77, "name": "m1", "status": "new", "vpc_uuid": vpcUUID, "created_at": "2026-10-29T10:00:00Z", "region": map[string]any{"slug": "nyc3"}, "size_slug": "s-1vcpu-1gb"}})
	})
	in, err := d.Create(t.Context(), Spec{Name: "m1", Region: "nyc3", Size: "s-1vcpu-1gb", UserData: "#cloud-config\n", VPCID: vpcUUID})
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(s.requests[0].Body, &got))
	assert.Equal(t, vpcUUID, got["vpc_uuid"])
	assert.Equal(t, vpcUUID, in.VPCID)
	assert.False(t, in.Created.IsZero(), "the creation time is read, for a prune's age")
	_, err = d.Create(t.Context(), Spec{Name: "m1", Region: "nyc3", Size: "s-1vcpu-1gb", UserData: "#cloud-config\n", VPCID: "../x"})
	assert.Error(t, err)
}

func TestDeleteSSHKeyIsByIdOrFingerprint(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) { w.WriteHeader(http.StatusNoContent) })
	require.NoError(t, d.DeleteSSHKey(t.Context(), "ab:cd:ef:01"))
	assert.Equal(t, "DELETE", s.requests[0].Method)
	assert.Equal(t, "/account/keys/ab:cd:ef:01", s.requests[0].Path)
	assert.Error(t, d.DeleteSSHKey(t.Context(), "../account"))
}

func TestFirewallSource(t *testing.T) {
	for _, ok := range []string{"203.0.113.7", "203.0.113.0/24", "2001:db8::1", "2001:db8::/48"} {
		_, err := firewallSource(ok)
		assert.NoError(t, err, ok)
	}
	for _, bad := range []string{"", "0.0.0.0/0", "::/0", "::", "0.0.0.0", "127.0.0.1", "::1", "224.0.0.1", "1.2.3.4/33", "a.b.c.d"} {
		_, err := firewallSource(bad)
		assert.Error(t, err, bad)
	}
}

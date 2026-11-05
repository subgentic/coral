package machinelaunch

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13592: a firewall applies by tag and DigitalOcean answers 422 "tag ... does not exist" when the tag was never made; the CLI never made it, so no launch could ever pass a real account. The fake below
// is stateful and refuses what DigitalOcean refuses: a firewall with an unknown tag, a tag made twice, a missing firewall.

type fakeDO struct {
	mu        sync.Mutex
	tags      map[string]bool
	firewalls map[string][]string // id -> tags
	failFW    bool                // the firewall create fails after the tag was made
	droplets  map[string]int      // tag -> droplets that still carry it
	deletes   []string
}

func newFakeDO(t *testing.T) (*fakeDO, *DigitalOcean) {
	f := &fakeDO{tags: map[string]bool{"production": true}, firewalls: map[string][]string{}}
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/tags":
			var in struct{ Name string }
			_ = json.Unmarshal(body, &in)
			if f.tags[in.Name] {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"id": "unprocessable_entity", "message": "Name has already been taken"})
				return
			}
			f.tags[in.Name] = true
			writeJSON(w, http.StatusCreated, map[string]any{"tag": map[string]any{"name": in.Name}})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/tags/"):
			name := strings.TrimPrefix(r.URL.Path, "/tags/")
			if !f.tags[name] {
				writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found", "message": "not found"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"tag": map[string]any{"name": name, "resources": map[string]any{"droplets": map[string]any{"count": f.droplets[name]}}}})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/tags/"):
			name := strings.TrimPrefix(r.URL.Path, "/tags/")
			f.deletes = append(f.deletes, name)
			delete(f.tags, name)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/firewalls":
			var in struct{ Tags []string }
			_ = json.Unmarshal(body, &in)
			for _, tg := range in.Tags {
				if !f.tags[tg] {
					writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"id": "unprocessable_entity", "message": "tag " + tg + " does not exist"})
					return
				}
			}
			if f.failFW {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"id": "server_error", "message": "try later"})
				return
			}
			f.firewalls[fwUUID] = in.Tags
			writeJSON(w, http.StatusAccepted, map[string]any{"firewall": map[string]any{"id": fwUUID, "name": "coral-fw-m1", "tags": in.Tags}})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/firewalls/"):
			tags, ok := f.firewalls[strings.TrimPrefix(r.URL.Path, "/firewalls/")]
			if !ok {
				writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found", "message": "not found"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"firewall": map[string]any{"id": fwUUID, "name": "coral-fw-m1", "tags": tags}})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/firewalls/"):
			id := strings.TrimPrefix(r.URL.Path, "/firewalls/")
			if _, ok := f.firewalls[id]; !ok {
				writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found", "message": "not found"})
				return
			}
			delete(f.firewalls, id)
			w.WriteHeader(http.StatusNoContent)
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"id": "not_found", "message": r.Method + " " + r.URL.Path})
		}
	})
	return f, d
}

func TestAFirewallForANewLaunchTagIsMadeWithItsTag(t *testing.T) {
	f, d := newFakeDO(t)
	const tag = "coral-launch-0123456789abcdef0123456789abcdef"
	fw, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: tag, SSHFrom: []string{"203.0.113.7/32"}})
	require.NoError(t, err, "DigitalOcean refuses a firewall whose tag does not exist: the tag is made first")
	assert.Equal(t, fwUUID, fw.ID)
	assert.True(t, f.tags[tag])
	// a tag that is already there (a retry) is not an error
	_, err = d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: tag})
	assert.NoError(t, err)
}

func TestDeletingTheFirewallDeletesTheLaunchTagAndOnlyThat(t *testing.T) {
	f, d := newFakeDO(t)
	const tag = "coral-launch-0123456789abcdef0123456789abcdef"
	_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: tag})
	require.NoError(t, err)
	f.firewalls[fwUUID] = []string{tag, "production"} // a person's own tag on it, too
	require.NoError(t, d.DeleteFirewall(t.Context(), fwUUID))
	assert.False(t, f.tags[tag], "the launch tag went with its firewall")
	assert.True(t, f.tags["production"], "a tag that is not a launch's is never deleted")
	assert.Equal(t, []string{tag}, f.deletes)
	assert.ErrorIs(t, d.DeleteFirewall(t.Context(), fwUUID), ErrNotFound, "one already gone is ErrNotFound, and no tag is deleted for it")
	assert.Equal(t, []string{tag}, f.deletes)
}

// The droplet delete before the firewall's can have failed: the tag then stays on the machine that may still exist, so the checks that look for it by the label still find it (Security's SHOULD).
func TestATagADropletStillCarriesIsNotDeleted(t *testing.T) {
	f, d := newFakeDO(t)
	const tag = "coral-launch-0123456789abcdef0123456789abcdef"
	_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: tag})
	require.NoError(t, err)
	f.droplets = map[string]int{tag: 1}
	require.NoError(t, d.DeleteFirewall(t.Context(), fwUUID))
	assert.True(t, f.tags[tag], "a droplet still carries it: the label stays")
	assert.Empty(t, f.deletes)
}

func TestAFirewallThatCannotBeMadeLeavesNoTagBehind(t *testing.T) {
	f, d := newFakeDO(t)
	f.failFW = true
	const tag = "coral-launch-0123456789abcdef0123456789abcdef"
	_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: tag})
	require.Error(t, err)
	assert.False(t, f.tags[tag], "the tag made for it is removed")
}

func TestOnlyALaunchTagIsEverMadeOrDeleted(t *testing.T) {
	f, d := newFakeDO(t)
	_, err := d.CreateFirewall(t.Context(), FirewallSpec{Name: "coral-fw-m1", Tag: "production"})
	assert.Error(t, err, "a tag that is not a launch's is not made, and so not touched")
	d.deleteLaunchTag("production")
	d.deleteLaunchTag("../droplets")
	assert.Empty(t, f.deletes)
	assert.True(t, f.tags["production"])
}

package routes

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #21213: two hubs reach one Coral. Each installed its own secret, kept per hub link; each hub's stamps are checked against its own, and a refusal says why and names the hub.

const (
	hubA    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hubB    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	secretA = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a"
	secretB = "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b"
)

func twoHubRig(t *testing.T) *stampRig {
	t.Helper()
	rig := newStampRig(t, false)
	// both hubs call this computer "mac": the id is the hub's own name for it, so two hubs may well pick the same one
	require.NoError(t, hubowner.Install(rig.dir, hubowner.Link{Hub: hubA, Name: "Studio hub", Remote: "mac", Secret: secretA}, time.Now()))
	require.NoError(t, hubowner.Install(rig.dir, hubowner.Link{Hub: hubB, Name: "Laptop hub", Remote: "mac", Secret: secretB}, time.Now()))
	return rig
}

func signedBy(t *testing.T, secret, remote, hub, body string, at time.Time) func(*http.Request) {
	t.Helper()
	s, err := hubowner.Sign(secret, remote, "POST", stampRoute, []byte(body), at)
	require.NoError(t, err)
	return func(r *http.Request) {
		r.Header.Set(hubowner.Header, s)
		if hub != "" {
			r.Header.Set(hubowner.LinkHeader, hub)
		}
	}
}

type refusal struct {
	Error  string `json:"error"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

func refusedAs(t *testing.T, w interface{ Result() *http.Response }, body string) refusal {
	t.Helper()
	var r refusal
	require.NoError(t, json.Unmarshal([]byte(body), &r), body)
	return r
}

func TestTwoHubsOnOneCoralEachHaveTheirOwnersStampsTaken(t *testing.T) {
	rig := twoHubRig(t)
	body := `{"decision":"approve"}`
	for name, mut := range map[string]func(*http.Request){
		"hub A":                 signedBy(t, secretA, "mac", hubA, body, time.Now()),
		"hub B":                 signedBy(t, secretB, "mac", hubB, body, time.Now()),
		"an older hub, no link": signedBy(t, secretB, "mac", "", body, time.Now()),
	} {
		w := rig.do("POST", stampRoute, body, mut)
		require.Equal(t, 200, w.Code, name+": "+w.Body.String())
		assert.True(t, rig.seen.human, name)
	}
	// the second hub's install did not replace the first's
	links, err := hubowner.Links(rig.dir)
	require.NoError(t, err)
	assert.Len(t, links, 2)
}

func TestAStampIsCheckedAgainstTheSecretOfTheHubThatSentItAndTheRefusalNamesIt(t *testing.T) {
	rig := twoHubRig(t)
	body := `{"decision":"approve"}`
	w := rig.do("POST", stampRoute, body, signedBy(t, secretA, "mac", hubB, body, time.Now()))
	require.Equal(t, 403, w.Code)
	r := refusedAs(t, w, w.Body.String())
	assert.Equal(t, "hub_owner_stamp_refused", r.Code)
	assert.Equal(t, hubowner.ReasonWrongSecret, r.Detail)
	assert.Contains(t, r.Error, `"Laptop hub"`, "the hub the stamp says it came from")
	assert.Contains(t, r.Error, "set up Approve through the hub again", "what to fix")
	assert.NotContains(t, strings.ToLower(r.Error), "clock", "only a stale stamp is about the clocks")
	assert.False(t, rig.seen.ran)
}

func TestEachRefusalSaysItsReasonAndOnlyAStaleOneIsAboutTheClocks(t *testing.T) {
	body := `{"decision":"approve"}`
	cases := []struct {
		name, reason, names string
		rig                 func(t *testing.T) *stampRig
		mut                 func(t *testing.T, rig *stampRig) func(*http.Request)
	}{
		{"stale", hubowner.ReasonStale, `"Studio hub"`, twoHubRig, func(t *testing.T, _ *stampRig) func(*http.Request) {
			return signedBy(t, secretA, "mac", hubA, body, time.Now().Add(-10*time.Minute))
		}},
		{"replay", hubowner.ReasonReplay, `"Studio hub"`, twoHubRig, func(t *testing.T, rig *stampRig) func(*http.Request) {
			m := signedBy(t, secretA, "mac", hubA, body, time.Now())
			require.Equal(t, 200, rig.do("POST", stampRoute, body, m).Code)
			return m
		}},
		{"no secret", hubowner.ReasonNoSecret, "", func(t *testing.T) *stampRig { return newStampRig(t, false) }, func(t *testing.T, _ *stampRig) func(*http.Request) {
			return signedBy(t, secretA, "mac", hubA, body, time.Now())
		}},
		{"unknown link", hubowner.ReasonUnknownLink, "", func(t *testing.T) *stampRig {
			rig := newStampRig(t, false)
			require.NoError(t, hubowner.Install(rig.dir, hubowner.Link{Hub: hubA, Name: "Studio hub", Remote: "mac", Secret: secretA}, time.Now()))
			return rig
		}, func(t *testing.T, _ *stampRig) func(*http.Request) {
			return signedBy(t, secretB, "mac", hubB, body, time.Now())
		}},
		{"malformed", hubowner.ReasonMalformed, "", twoHubRig, func(t *testing.T, _ *stampRig) func(*http.Request) {
			return func(r *http.Request) {
				r.Header.Set(hubowner.Header, "v1.nonsense")
				r.Header.Set(hubowner.LinkHeader, hubA)
			}
		}},
	}
	for _, c := range cases {
		rig := c.rig(t)
		w := rig.do("POST", stampRoute, body, c.mut(t, rig))
		require.Equal(t, 403, w.Code, c.name)
		r := refusedAs(t, w, w.Body.String())
		assert.Equal(t, c.reason, r.Detail, c.name)
		if c.names != "" {
			assert.Contains(t, r.Error, c.names, c.name)
		}
		assert.Equal(t, c.reason == hubowner.ReasonStale, strings.Contains(strings.ToLower(r.Error), "clock"), c.name+": "+r.Error)
		assert.NotContains(t, r.Error, secretA, c.name)
	}
}

// An upgrade breaks no link that works today: the single secret an older hub installed keeps verifying, from that hub (no link header) and from the same hub once it is upgraded and sends its id.
func TestAnUpgradedCoralKeepsTheSingleSecretWorking(t *testing.T) {
	rig := newStampRig(t, true) // the single file, "ssh-box"
	body := `{"decision":"approve"}`
	require.Equal(t, 200, rig.do("POST", stampRoute, body, signedBy(t, stampSecret, "ssh-box", "", body, time.Now())).Code, "the older hub")
	require.Equal(t, 200, rig.do("POST", stampRoute, body, signedBy(t, stampSecret, "ssh-box", hubA, body, time.Now())).Code, "the same hub, upgraded, before it installs again")
	assert.True(t, rig.seen.human)

	// it installs again with its id: its old single secret goes (a rotation must not leave it working), another hub's link stays
	require.NoError(t, hubowner.Install(rig.dir, hubowner.Link{Hub: hubB, Remote: "other", Secret: secretB}, time.Now()))
	require.NoError(t, hubowner.Install(rig.dir, hubowner.Link{Hub: hubA, Remote: "ssh-box", Secret: secretA}, time.Now()))
	w := rig.do("POST", stampRoute, body, signedBy(t, stampSecret, "ssh-box", hubA, body, time.Now()))
	require.Equal(t, 403, w.Code, "the replaced secret")
	assert.Equal(t, hubowner.ReasonWrongSecret, refusedAs(t, w, w.Body.String()).Detail)
	require.Equal(t, 200, rig.do("POST", stampRoute, body, signedBy(t, secretA, "ssh-box", hubA, body, time.Now())).Code)
	require.Equal(t, 200, rig.do("POST", stampRoute, body, signedBy(t, secretB, "other", hubB, body, time.Now())).Code)
}

// Removing a link drops its secret only: that hub's stamps are refused, the other hub's still work.
func TestRemovingOneHubsLinkLeavesTheOther(t *testing.T) {
	rig := twoHubRig(t)
	body := `{"decision":"approve"}`
	n, err := hubowner.Remove(rig.dir, hubA)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	w := rig.do("POST", stampRoute, body, signedBy(t, secretA, "mac", hubA, body, time.Now()))
	require.Equal(t, 403, w.Code)
	assert.Equal(t, hubowner.ReasonUnknownLink, refusedAs(t, w, w.Body.String()).Detail)
	require.Equal(t, 200, rig.do("POST", stampRoute, body, signedBy(t, secretB, "mac", hubB, body, time.Now())).Code)
}

// A link header that is not one hub id is refused like a malformed stamp: two of them, or one that is not an id.
func TestALinkHeaderThatIsNotOneHubIDIsRefused(t *testing.T) {
	rig := twoHubRig(t)
	body := `{"decision":"approve"}`
	for name, extra := range map[string]func(*http.Request){
		"two": func(r *http.Request) { r.Header.Add(hubowner.LinkHeader, hubB) },
		"bad": func(r *http.Request) { r.Header.Set(hubowner.LinkHeader, "Not An Id") },
	} {
		base := signedBy(t, secretA, "mac", hubA, body, time.Now())
		w := rig.do("POST", stampRoute, body, func(r *http.Request) { base(r); extra(r) })
		require.Equal(t, 403, w.Code, name)
		assert.Equal(t, hubowner.ReasonMalformed, refusedAs(t, w, w.Body.String()).Detail, name)
	}
}

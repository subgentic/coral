package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The age of an agent decides "starting" and "not started" in each tick, from the clock of THAT tick. These tests register agents with a creation time they choose and compare a build
// that reuses the previous tick's rows with a full rebuild: the gaps around #11351's fix (the age crossing the window between ticks; a session id registered again; the shared rows
// left alone by the roster scope and the field diff).

type ageRig struct {
	t    *testing.T
	h    *SessionsHandler
	term *mockSessionTerminal
}

func newAgeRig(t *testing.T) *ageRig {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	rig := &ageRig{t: t, term: newMockTerminal()}
	rig.h = NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, rig.term, nil)
	return rig
}

// register (re-)registers the agent created this long ago (as "INSERT OR REPLACE" does for a session id that is registered again).
func (r *ageRig) register(sid string, ago time.Duration) {
	r.t.Helper()
	tmux := naming.SessionName("claude", sid)
	r.term.addSession(tmux, "/tmp/"+sid[:4])
	ls := &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "a-" + sid[:4], WorkingDir: "/tmp/" + sid[:4], CreatedAt: time.Now().Add(-ago).UTC().Format(store.ISOFormat)}
	require.NoError(r.t, r.h.ss.RegisterLiveSession(context.Background(), ls))
}

func (r *ageRig) kill(sid string) {
	r.term.KillSession(context.Background(), naming.SessionName("claude", sid), "", "")
}

// build is a tick that reuses prev, checked against a full rebuild; it returns the part and the row of sid (nil if there is none).
func (r *ageRig) build(prev *wsLocalPart, sid string) (*wsLocalPart, map[string]any) {
	r.t.Helper()
	req := httptest.NewRequest("GET", "/ws/coral", nil)
	got := r.h.buildWSLocalPart(req, false, prev)
	want := r.h.buildWSLocalPart(req, false, nil)
	require.NoError(r.t, got.err)
	require.Equal(r.t, len(want.sessions), len(got.sessions))
	var row map[string]any
	for i, k := range got.keys {
		require.Equal(r.t, want.serialized[i], got.serialized[i], "the reused build sends what a full rebuild sends")
		if k == "session_id:"+sid || (got.sessions[i]["session_id"] == sid) {
			row = got.sessions[i]
		}
	}
	return got, row // nil when the agent has no row (its pane is gone)
}

const ageSID = "0000a1b2-2222-3333-4444-555555555555"

// An agent registered in the same clock tick as a list build shows "starting", and the row keeps saying the right thing as the clock moves past the not-started window: a reused
// row is rebuilt when the age (not an input of its own) changes what it says. The agent is registered 1 s before the window ends and the last tick is built 1.2 s later.
func TestTheRowFollowsTheAgeAcrossTheWindowInAReusedBuild(t *testing.T) {
	r := newAgeRig(t)
	r.register(ageSID, 0) // created in this very tick
	part, row := r.build(nil, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, true, row["starting"], "just registered")

	r.register(ageSID, (notStartedWindowSeconds-1)*time.Second) // registered again, 1 s short of the window's end
	part, row = r.build(part, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, true, row["starting"], "inside the window, no event yet")

	time.Sleep(1200 * time.Millisecond) // the clock crosses the window; nothing stored about the agent changes
	_, row = r.build(part, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, false, row["starting"], "past the window the row stops saying starting, though none of its stored inputs changed")
}

// The same session id killed and registered again with a different creation time: the row is computed from the new one, not kept from the old registration.
func TestASessionIdRegisteredAgainTakesTheNewCreationTime(t *testing.T) {
	r := newAgeRig(t)
	old := (notStartedWindowSeconds + 30) * time.Second
	r.register(ageSID, old) // an old registration, past the window
	part, row := r.build(nil, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, false, row["starting"], "an old agent is not starting")

	r.kill(ageSID)
	part, _ = r.build(part, ageSID) // the pane is gone for a tick (the row may be absent or dead: only the next one matters)
	r.register(ageSID, 0)           // re-added, created now
	part, row = r.build(part, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, true, row["starting"], "re-added in this tick: just started, not the old registration's age")

	r.register(ageSID, old) // and back to an old creation time
	_, row = r.build(part, ageSID)
	require.NotNil(t, row)
	assert.Equal(t, false, row["starting"], "registered again with an old creation time: not starting")
}

// The roster scope and the field diff never change the rows of the shared tick: the same rows go to every connection and the next tick reuses them (a deep copy taken before
// equals the rows after).
func TestRosterScopeAndFieldDiffLeaveTheSharedTickAlone(t *testing.T) {
	r := newAgeRig(t)
	other := "0000c3d4-2222-3333-4444-555555555555"
	r.register(ageSID, 0)
	r.register(other, 0)
	part, _ := r.build(nil, ageSID)
	tick := assembleWSTick(part, &wsRemotePart{})
	before, err := json.Marshal(tick.sessions)
	require.NoError(t, err)
	serialized := map[string]string{}
	for k, v := range tick.current {
		serialized[k] = v
	}

	scoped := scopeTickForAgent(tick, ageSID)
	require.NotEmpty(t, scoped.sessions)
	// the field diff of every row against a changed copy of itself
	for key, row := range tick.byKey {
		changed := map[string]any{}
		for k, v := range row {
			changed[k] = v
		}
		changed["starting"] = !(row["starting"] == true)
		d := fieldDelta(row, changed)
		assert.Contains(t, d, "starting", key)
	}

	after, err := json.Marshal(tick.sessions)
	require.NoError(t, err)
	assert.JSONEq(t, string(before), string(after), "the shared rows are as they were")
	assert.Equal(t, serialized, tick.current, "and so are their serialized forms")
}

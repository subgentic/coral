package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14047: each goal carries the Operator's done-state (done_state: hidden "dismissed" or "not_yet", read) for the Operator's own read, from the lists the done-state route writes, so a Dismiss, Not yet or read made through
// a Hub is still there after a reload. A viewer, a guest or an agent gets the goals as before.

type doneReadRig struct {
	t   *testing.T
	h   *BoardHandler
	bs  *board.Store
	ls  *listStore
	srv *httptest.Server
}

func newDoneReadRig(t *testing.T) *doneReadRig {
	bs, err := boardtest.Open(t.TempDir() + "/board.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	ls := &listStore{}
	h.SetGoalDoneEdit(ls.edit)
	h.SetGoalDoneHidden(func(context.Context) []string { return ls.get("goal_done_hidden") })
	h.SetGoalDoneRead(func(context.Context) []string { return ls.get("goal_done_read") })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			switch req.Header.Get("X-Test-Who") {
			case "person":
				req = asPerson(req)
			case "agent":
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/api/goals", h.ListAllGoals)
	r.Get("/api/board/{project}/goals", h.ListGoals)
	r.Get("/api/board/{project}/goals/{goalID}", h.GetGoal)
	r.Post("/api/board/{project}/goals/{goalID}/done-state", h.SetGoalDoneState)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	for _, who := range []string{"Operator", "Lead", "Dev"} {
		_, err := bs.Subscribe(context.Background(), "alpha", who, who, "", nil, "")
		require.NoError(t, err)
	}
	return &doneReadRig{t: t, h: h, bs: bs, ls: ls, srv: srv}
}

func (d *doneReadRig) do(method, path string, body any, hdr map[string]string) (int, map[string]any) {
	d.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, d.srv.URL+path, rd)
	require.NoError(d.t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(d.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// goalRow is the one goal's row out of a list answer.
func goalRow(t *testing.T, out map[string]any, id int64) map[string]any {
	t.Helper()
	list, _ := out["goals"].([]any)
	for _, g := range list {
		if m := g.(map[string]any); int64(m["id"].(float64)) == id {
			return m
		}
	}
	t.Fatalf("goal %d is not in %v", id, out)
	return nil
}

var (
	drPerson   = map[string]string{"X-Test-Who": "person"}
	drAgent    = map[string]string{"X-Test-Who": "agent"}
	drHubOwner = map[string]string{"X-Test-Who": "person", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: cmtHubUser, tunnel.HubRoleHeader: "owner"}
	drHubGuest = map[string]string{"X-Test-Who": "person", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: cmtHubTwo}
)

// reads is the three reads that carry the goal: every board's, one board's, one goal.
func (d *doneReadRig) reads(id int64, hdr map[string]string) map[string]map[string]any {
	d.t.Helper()
	out := map[string]map[string]any{}
	code, all := d.do("GET", "/api/goals?state=active", nil, hdr)
	require.Equal(d.t, 200, code, all)
	out["all"] = goalRow(d.t, all, id)
	code, one := d.do("GET", "/api/board/alpha/goals?state=active", nil, hdr)
	require.Equal(d.t, 200, code, one)
	out["board"] = goalRow(d.t, one, id)
	code, g := d.do("GET", "/api/board/alpha/goals/"+strconv.FormatInt(id, 10), nil, hdr)
	require.Equal(d.t, 200, code, g)
	out["goal"] = g
	return out
}

func (d *doneReadRig) doneGoal() *board.Goal {
	ctx := context.Background()
	gl, err := d.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Ship the release", Outcome: "Version two is out.", DoneWhen: "The tag is pushed.", CreatedBy: "Operator", Driver: "Lead"})
	require.NoError(d.t, err)
	tk, err := d.bs.CreateTaskWithOpts(ctx, "alpha", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &gl.ID})
	require.NoError(d.t, err)
	_, err = d.bs.ClaimTask(ctx, "alpha", "Dev", tk.ID)
	require.NoError(d.t, err)
	_, err = d.bs.CompleteTask(ctx, "alpha", tk.ID, "Dev", nil)
	require.NoError(d.t, err)
	gl, err = d.bs.GetGoal(ctx, "alpha", gl.ID)
	require.NoError(d.t, err)
	return gl
}

func (d *doneReadRig) state(id int64, state string, hdr map[string]string) {
	d.t.Helper()
	code, out := d.do("POST", "/api/board/alpha/goals/"+strconv.FormatInt(id, 10)+"/done-state", map[string]any{"state": state}, hdr)
	require.Equal(d.t, 200, code, out)
}

func TestTheOwnerSeesEachDoneStateAfterAWriteOnEveryGoalRead(t *testing.T) {
	d := newDoneReadRig(t)
	withLabel(t, cmtHubUser, nil)
	gl := d.doneGoal()
	// nothing written: no done_state, on every read
	for name, row := range d.reads(gl.ID, drPerson) {
		assert.NotContains(t, row, "done_state", name)
	}
	cases := []struct {
		write string
		want  map[string]any
	}{
		{"not_yet", map[string]any{"hidden": "not_yet"}},
		{"dismiss", map[string]any{"hidden": "dismissed"}}, // dismissed wins over the not-yet entry that is still in the list
		{"show", nil},
		{"read", map[string]any{"read": true}},
		{"unread", nil},
	}
	for _, who := range []struct {
		name string
		hdr  map[string]string
	}{{"the person at this computer", drPerson}, {"the Hub's owner", drHubOwner}} {
		for _, c := range cases {
			d.state(gl.ID, c.write, who.hdr)
			for name, row := range d.reads(gl.ID, who.hdr) {
				if c.want == nil {
					assert.NotContains(t, row, "done_state", "%s after %s, %s", who.name, c.write, name)
				} else {
					assert.Equal(t, c.want, row["done_state"], "%s after %s, %s", who.name, c.write, name)
				}
			}
		}
	}
	// hidden and read together, and read through the person after the Hub owner wrote it: one store
	d.state(gl.ID, "not_yet", drHubOwner)
	d.state(gl.ID, "read", drHubOwner)
	for name, row := range d.reads(gl.ID, drPerson) {
		assert.Equal(t, map[string]any{"hidden": "not_yet", "read": true}, row["done_state"], name)
	}
}

func TestOnlyWhatAppliesNowIsSaid(t *testing.T) {
	d := newDoneReadRig(t)
	gl := d.doneGoal()
	d.state(gl.ID, "not_yet", drPerson)
	d.state(gl.ID, "read", drPerson)
	// another task is done: the goal's total changes, so a Not yet at the old total no longer hides it
	ctx := context.Background()
	tk, err := d.bs.CreateTaskWithOpts(ctx, "alpha", "t2", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &gl.ID})
	require.NoError(t, err)
	_, err = d.bs.ClaimTask(ctx, "alpha", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = d.bs.CompleteTask(ctx, "alpha", tk.ID, "Dev", nil)
	require.NoError(t, err)
	for name, row := range d.reads(gl.ID, drPerson) {
		assert.NotContains(t, row, "done_state", "%s: the entries are for the old total", name)
	}
}

func TestAViewerAGuestAndAnAgentGetTheGoalsWithNoDoneState(t *testing.T) {
	d := newDoneReadRig(t)
	withLabel(t, cmtHubUser, nil)
	gl := d.doneGoal()
	d.state(gl.ID, "dismiss", drPerson)
	d.state(gl.ID, "read", drPerson)
	for who, hdr := range map[string]map[string]string{"a Hub guest or viewer": drHubGuest, "an agent": drAgent} {
		code, all := d.do("GET", "/api/goals?state=active", nil, hdr)
		if who == "an agent" {
			require.Equal(t, 200, code, who) // the identity layer refuses an agent's token on the real server; this handler alone hands it the goals as before, without the state
		}
		require.Equal(t, 200, code, who)
		row := goalRow(t, all, gl.ID)
		assert.Equal(t, "Ship the release", row["title"], who+": the goals as before")
		for name, r := range map[string]map[string]any{"all": row, "board": goalRow(t, mustGet(t, d, "/api/board/alpha/goals?state=active", hdr), gl.ID), "goal": mustGet(t, d, "/api/board/alpha/goals/"+strconv.FormatInt(gl.ID, 10), hdr)} {
			assert.NotContains(t, r, "done_state", who+", "+name)
		}
	}
}

func mustGet(t *testing.T, d *doneReadRig, path string, hdr map[string]string) map[string]any {
	t.Helper()
	code, out := d.do("GET", path, nil, hdr)
	require.Equal(t, 200, code, out)
	return out
}

// The table: the three goal reads are OwnerSees routes (the owner is stamped, nobody is refused), at the same View tier.
func TestTheGoalReadsAreOwnerSeesRoutesAtViewTier(t *testing.T) {
	for _, p := range []string{"/api/goals", "/api/board/alpha/goals", "/api/board/alpha/goals/12"} {
		_, mode := tunnel.OwnerRoute(http.MethodGet, p)
		assert.Equal(t, tunnel.OwnerSees, mode, p)
		assert.False(t, mode.Refuses(), p+": no viewer is refused")
		_, tier, ok := tunnel.RuleFor(http.MethodGet, p)
		require.True(t, ok, p)
		assert.Equal(t, tunnel.TierView, tier, p)
	}
}

// QA's SHOULD on #14047: a Not yet written at total N is no longer a state once the goal's total is N+1, on its own (no read beside it to hide the case), and it is a state again when written at the new total; a Dismiss
// has no total and stays. The older entry never comes back: it is a different total.
func TestANotYetAtTotalNIsNoStateAtNPlusOneAndOnlyThatEntryGoesStale(t *testing.T) {
	d := newDoneReadRig(t)
	gl := d.doneGoal()
	require.Equal(t, 1, gl.Rollup.Total)
	done := func() { // one more task, done: the all-done total goes up by one
		ctx := context.Background()
		tk, err := d.bs.CreateTaskWithOpts(ctx, "alpha", "more", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &gl.ID})
		require.NoError(t, err)
		_, err = d.bs.ClaimTask(ctx, "alpha", "Dev", tk.ID)
		require.NoError(t, err)
		_, err = d.bs.CompleteTask(ctx, "alpha", tk.ID, "Dev", nil)
		require.NoError(t, err)
	}
	hidden := func() any {
		var seen any
		for name, row := range d.reads(gl.ID, drPerson) {
			ds, _ := row["done_state"].(map[string]any)
			var h any
			if ds != nil {
				h = ds["hidden"]
			}
			if seen == nil {
				seen = h
			}
			assert.Equal(t, seen, h, "the three reads agree: %s", name)
		}
		return seen
	}
	d.state(gl.ID, "not_yet", drPerson) // at total 1
	assert.Equal(t, "not_yet", hidden())
	done() // total 2
	assert.Nil(t, hidden(), "a Not yet at total 1 is no state at total 2")
	d.state(gl.ID, "not_yet", drPerson) // at total 2
	assert.Equal(t, "not_yet", hidden())
	assert.Equal(t, []string{"alpha|" + strconv.FormatInt(gl.ID, 10) + "|1", "alpha|" + strconv.FormatInt(gl.ID, 10) + "|2"}, d.ls.get("goal_done_hidden"), "the old entry is still in the list, and still no state")
	done() // total 3
	assert.Nil(t, hidden(), "neither the entry at 1 nor the one at 2 applies at total 3")
	d.state(gl.ID, "dismiss", drPerson)
	assert.Equal(t, "dismissed", hidden())
	done() // total 4
	assert.Equal(t, "dismissed", hidden(), "a Dismiss has no total: it stays")
}

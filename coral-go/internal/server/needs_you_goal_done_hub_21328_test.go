package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21328 (coral-hub, the Operator): a "Goal looks done" row the Operator hid here (Not yet or Dismiss) must be hidden for the Hub's owner too, read through the tunnel as GET /api/needs-you.
func TestAHiddenGoalDoneRowIsHiddenThroughTheHubToo(t *testing.T) {
	r := newE2ERemote(t, "goal-done-hub", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}
	ctx := t.Context()
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.cfg.CoralDir()))
	require.NoError(t, cs.Save(ctx, "https://hub.example.invalid", "srv_1", "L", "coralhub_srv_abcd1234_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
	pinned, err := cs.PinOwnerUser(ctx, "srv_1", "hub-user-1234abcd")
	require.NoError(t, err)
	require.True(t, pinned)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)
	lk, err := cs.LinkByOrigin(ctx, "https://hub.example.invalid")
	require.NoError(t, err)
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd", tunnel.LinkHeader: lk.LinkID}
	require.NoError(t, store.NewSessionStore(r.db).SaveSettings(ctx, map[string]string{"goal_done_quiet_minutes": "0"}))

	// a board with one goal whose tasks are all done
	bs := r.srv.boardStore
	_, err = bs.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	rec := call(h, "POST", "/api/board/team/goals", `{"subscriber_id":"Operator","title":"Ship it","outcome":"o","done_when":"d"}`, js)
	require.Less(t, rec.Code, 300, rec.Body.String())
	var g struct{ ID int64 }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &g))
	rec = call(h, "POST", "/api/board/team/tasks", `{"title":"t","subscriber_id":"Operator","goal_id":`+itoa(g.ID)+`}`, js)
	require.Less(t, rec.Code, 300, rec.Body.String())
	var tk struct{ ID int64 }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tk))
	_, err = bs.ClaimTask(ctx, "team", "Lead", tk.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", tk.ID, "Lead", nil)
	require.NoError(t, err)

	goalRows := func(hdr map[string]string) int {
		n := -1
		for _, q := range []string{"", "?kind=goal_done", "?limit=200", "?kind=goal_done&limit=200"} { // every first-page read a Hub makes says the same
			rec := call(h, "GET", "/api/needs-you"+q, "", hdr)
			require.Equal(t, 200, rec.Code, rec.Body.String())
			got := strings.Count(rec.Body.String(), `"kind":"goal_done"`)
			var out struct {
				Counts map[string]int `json:"counts"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
			assert.Equal(t, got, out.Counts["goal_done"], q+": the count and the rows agree")
			if n >= 0 {
				assert.Equal(t, n, got, q)
			}
			n = got
		}
		return n
	}
	person := map[string]string{"Sec-Fetch-Site": "same-origin"}
	require.Equal(t, 1, goalRows(person), "the local person sees the row before hiding it")
	require.Equal(t, 1, goalRows(owner), "and so does the Hub's owner")

	// the Operator hides it here, as the dashboard does
	rec = call(h, "POST", "/api/board/team/goals/"+itoa(g.ID)+"/done-state", `{"state":"not_yet"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Equal(t, 0, goalRows(person), "hidden for the person here")
	assert.Equal(t, 0, goalRows(owner), "and hidden for the Hub's owner reading through the tunnel")
}

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/pkg/resourcequeue"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13671: the resource queue's analytics are numbers only, the Operator's alone and this computer's.

type rqClock struct{ t time.Time }

func (c *rqClock) now() time.Time { return c.t }

func rqServer(t *testing.T, rig *cmtRig, person bool) (*httptest.Server, *resources.Manager, *rqClock) {
	t.Helper()
	clk := &rqClock{t: time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)}
	dir := t.TempDir()
	m, err := resources.Open(resources.Options{Path: filepath.Join(dir, "r.json"), HistoryPath: filepath.Join(dir, "h.db"), AgeStep: -1, Now: clk.now})
	require.NoError(t, err)
	t.Cleanup(m.Close)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1}))
	h := NewResourceQueueAnalyticsHandler(m, rig.h.bs)
	h.now = clk.now
	r := chi.NewRouter()
	r.Get("/api/analytics/resource-queue", func(w http.ResponseWriter, req *http.Request) {
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		h.Read(w, req)
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	return s, m, clk
}

func getRQ(t *testing.T, base, query string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest("GET", base+"/api/analytics/resource-queue"+query, nil)
	require.NoError(t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestTheResourceQueueReadCountsUseWaitsAndTheBeforeAfterWithoutAnyText(t *testing.T) {
	rig := newCmtRig(t)
	srv, m, clk := rqServer(t, rig, true)
	ctx := context.Background()
	// an hour of use on the 5th: a holds 20 minutes, b waits 20 minutes behind it and holds 10, c is refused once by the hook
	clk.t = time.Date(2026, 11, 5, 16, 0, 0, 0, time.UTC)
	_, err := m.ClaimAuto(ctx, "mac-heavy", "a", "go test ./...")
	require.NoError(t, err)
	_, err = m.Claim(ctx, "mac-heavy", "b", "a private note that must never be sent")
	require.NoError(t, err)
	clk.t = clk.t.Add(20 * time.Minute)
	require.NoError(t, m.Queue().Release("mac-heavy", "a"))
	clk.t = clk.t.Add(10 * time.Minute)
	require.NoError(t, m.Queue().Release("mac-heavy", "b"))
	m.Record(resourcequeue.Event{At: clk.t, Kind: "refused", Resource: "mac-heavy", Agent: "c", Via: "hook", Pattern: "go test ./..."})
	_, err = rig.h.bs.PostMessage(ctx, "team", "Dev", "HEAVY RUN START: Dev, Mac, a secret-task-text", nil)
	require.NoError(t, err)
	m.History().Flush()
	clk.t = time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)

	code, out := getRQ(t, srv.URL, "?days=7", nil)
	require.Equal(t, http.StatusOK, code, out)
	raw, _ := json.Marshal(out)
	assert.NotContains(t, string(raw), "private note", "no note in the numbers")
	assert.NotContains(t, string(raw), "secret-task-text", "no post text in the numbers")
	assert.Equal(t, "2026-11-05T16:00:00Z", out["go_live"])
	res := out["resources"].([]any)
	require.Len(t, res, 1)
	r0 := res[0].(map[string]any)
	assert.EqualValues(t, 2, r0["claims"], "two grants")
	assert.EqualValues(t, 1, r0["auto"])
	assert.EqualValues(t, 1, r0["hand"])
	assert.EqualValues(t, 1, r0["refused"])
	assert.EqualValues(t, 1200, r0["wait_median_s"], "b waited twenty minutes (the other grant waited none: median of 0 and 1200 is the upper middle)")
	assert.InDelta(t, 30.0/(7*24*60), r0["busy_pct"].(float64)/100, 0.0001, "thirty minutes held of seven days on one slot")
	assert.Equal(t, true, out["history"])
	agents := out["by_agent"].([]any)
	assert.Len(t, agents, 2)
	pats := out["by_pattern"].([]any)
	require.Len(t, pats, 1)
	assert.Equal(t, "go test ./...", pats[0].(map[string]any)["pattern"])
}

func TestTheResourceQueueReadIsThePersonsAloneAndThisComputersAndCutsDays(t *testing.T) {
	rig := newCmtRig(t)
	notPerson, _, _ := rqServer(t, rig, false)
	code, _ := getRQ(t, notPerson.URL, "", nil)
	assert.Equal(t, http.StatusForbidden, code)
	srv, _, _ := rqServer(t, rig, true)
	for name, hdr := range map[string]map[string]string{
		"a Hub stamp":     {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "someone"},
		"the Hub's owner": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"},
	} {
		code, _ := getRQ(t, srv.URL, "", hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
	_, out := getRQ(t, srv.URL, "?days=5000", nil)
	assert.EqualValues(t, 90, out["days_asked"])
	for _, bad := range []string{"?days=0", "?days=x"} {
		code, _ := getRQ(t, srv.URL, bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/tracking"
)

// D1 and D3 (#7522): an Inbox action through its real handler sends kind, action and surface only, never anything of the item (its title, outcome, id or
// board), and only for a person's own action; the surface the page names goes through the closed list (D2).
func TestAnInboxActionCarriesNothingOfTheItemAndOnlyAPersonsCounts(t *testing.T) {
	sink := captureAnalytics(t)
	e := newProposalEnv(t)
	e.settings(t, board.BoardSettingsUpdate{GoalsNeedApproval: boolp(true)})
	_, a := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "secret-goal-title", "outcome": "secret-outcome-text", "subscriber_id": "Orchestrator"})
	_, b := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "secret-second-title", "outcome": "x", "subscriber_id": "Orchestrator"})
	ida, idb := int64(a["proposal_id"].(float64)), int64(b["proposal_id"].(float64))

	// An approval that is not a person's (no dashboard caller): no Inbox event, whatever the handler answers.
	_, _ = e.call(t, "", "POST", "/api/board/team/proposals/"+itoa(idb)+"/reject", map[string]any{"reason": "secret-reason"})
	sink.none(t, tracking.EventInboxItemActioned)

	// The person's own approval, from the Inbox, with a surface the page made up first: other.
	approve := func(id int64, surface string) {
		req, err := http.NewRequest("POST", e.srv.URL+"/api/board/team/proposals/"+itoa(id)+"/approve", bytes.NewReader(nil))
		require.NoError(t, err)
		req.Header.Set("X-Test-Caller", "person")
		req.Header.Set("X-Coral-Surface", surface)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
	}
	approve(ida, "secret-surface")
	got := sink.wait(t, tracking.EventInboxItemActioned, 1)
	assert.Equal(t, tracking.InboxProposal, got[0]["kind"])
	assert.Equal(t, "approve", got[0]["action"])
	assert.Equal(t, tracking.InboxOther, got[0]["surface"], "a surface off the list is other")
	_, hasSecs := got[0]["secs_to_action"]
	assert.True(t, hasSecs, "the proposal's own creation time gives the seconds")

	raw := sink.allRaw()
	for _, seeded := range []string{"secret-goal-title", "secret-outcome-text", "secret-second-title", "secret-reason", "secret-surface", `"team"`, "Orchestrator", "proposal_id"} {
		assert.NotContains(t, raw, seeded, "nothing of the item reaches the sink")
	}
}

// inbox_opened: the page names the event and nothing else; what waits is the server's own count, and only a person's opening counts.
func TestInboxOpenedTakesTheServersCountsAndAPersonsOpeningOnly(t *testing.T) {
	sink := captureAnalytics(t)
	h := NewTrackingHandler(t.TempDir())
	calls := 0
	h.SetInboxCounts(func(*http.Request) map[string]int {
		calls++
		return map[string]int{tracking.InboxAgentWait: 1, tracking.InboxReview: 4}
	})
	post := func(person bool) int {
		body, _ := json.Marshal(map[string]any{"event": tracking.EventInboxOpened, "props": map[string]string{"waiting": "0", "kind": "secret-kind", "board": "secret-board"}})
		req := httptest.NewRequest("POST", "/api/tracking/event", bytes.NewReader(body))
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		w := httptest.NewRecorder()
		h.TrackEvent(w, req)
		return w.Code
	}
	assert.Equal(t, http.StatusOK, post(false))
	sink.none(t, tracking.EventInboxOpened)
	assert.Zero(t, calls, "not a person: nothing is counted")

	assert.Equal(t, http.StatusOK, post(true))
	opened := sink.wait(t, tracking.EventInboxOpened, 1)
	assert.Equal(t, "3-5", opened[0]["waiting"], "the server's count (5), not the page's 0")
	waiting := sink.wait(t, tracking.EventInboxWaiting, 2)
	kinds := map[string]any{}
	for _, p := range waiting {
		kinds[p["kind"].(string)] = p["waiting"]
	}
	assert.Equal(t, map[string]any{tracking.InboxAgentWait: "1-2", tracking.InboxReview: "3-5"}, kinds)
	assert.False(t, strings.Contains(sink.allRaw(), "secret-"), "the page's properties never reach the sink")
}

// D3 through a real route that any caller may use (marking a failed run seen): the route answers an agent's tool and a script as it answers a
// person, and only the person's call sends inbox_item_actioned. So the guard in inboxActioned decides, not the route's own checks.
func TestOnlyAPersonsActionSendsAnInboxEventEvenWhereTheRouteAnswersEveryone(t *testing.T) {
	sink := captureAnalytics(t)
	cfg := config.Load(t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	sh := NewScheduleHandler(db, cfg)
	ctx := context.Background()
	job, err := sh.sched.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "secret-job-name", CronExpr: "* * * * *", RepoPath: "/tmp/secret-repo", Prompt: "secret prompt", Enabled: 1})
	require.NoError(t, err)
	run, err := sh.sched.CreateScheduledRun(ctx, job.ID, "2026-10-27T00:00:00Z", "failed")
	require.NoError(t, err)
	path := "/api/scheduled/runs/" + strconv.FormatInt(run, 10) + "/seen"
	r := chi.NewRouter()
	r.Post("/api/scheduled/runs/{runID}/seen", sh.MarkRunSeen)
	seen := func(prep func(*http.Request) *http.Request) int {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-Coral-Surface", "inbox")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, prep(req))
		return rec.Code
	}

	// An agent's tool (its session token) and a script (no caller the identity layer knows): the route answers both, and nothing is sent.
	assert.Equal(t, http.StatusOK, seen(func(req *http.Request) *http.Request {
		req.Header.Set(store.SessionTokenHeader, "an-agent-token")
		return req
	}))
	assert.Equal(t, http.StatusOK, seen(func(req *http.Request) *http.Request { return req }))
	sink.none(t, tracking.EventInboxItemActioned)

	// The person: one event, kind and action only.
	assert.Equal(t, http.StatusOK, seen(func(req *http.Request) *http.Request {
		return req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}))
	got := sink.wait(t, tracking.EventInboxItemActioned, 1)
	assert.Equal(t, tracking.InboxRun, got[0]["kind"])
	assert.Equal(t, "seen", got[0]["action"])
	assert.Equal(t, "inbox", got[0]["surface"])
	for _, seeded := range []string{"secret-job-name", "secret-repo", "secret prompt"} {
		assert.NotContains(t, sink.allRaw(), seeded)
	}
}

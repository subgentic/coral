package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12069: the Activity record through the real handlers: a decision writes its row (the version decided, the actor and source from the request), a rolled-back one says so, and the read is the Operator's alone.

func (e *reviewEnv) activityServer(t *testing.T, person bool) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	r.Get("/api/activity", func(w http.ResponseWriter, req *http.Request) {
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		e.h.ListActivity(w, req)
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	return s
}

func getActivity(t *testing.T, base, query string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest("GET", base+"/api/activity"+query, nil)
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

func TestAnApprovalAndADenialAreInTheRecordWithTheVersionDecidedAndTheActorFromTheRequest(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"deny","reason":"`+strings.Repeat("no ", 100)+`"}`)
	require.Equal(t, http.StatusOK, code, out)
	code, out = getActivity(t, act.URL, "", nil)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 1)
	row := rows[0].(map[string]any)
	assert.Equal(t, "deny", row["action"])
	assert.Equal(t, e.id, row["version"], "the digest of the exact version decided")
	assert.Equal(t, e.id, row["item_id"])
	assert.Equal(t, "alpha", row["team"])
	assert.Equal(t, "local", row["source"])
	assert.Equal(t, "local", row["actor"])
	assert.Equal(t, "plan.md", row["title"])
	assert.LessOrEqual(t, len([]rune(row["note"].(string))), 200, "the reason is cut")
	assert.Equal(t, true, out["check"].(map[string]any)["intact"])
	assert.NotContains(t, row, "prev_hash")
	assert.NotContains(t, row, "hash")
}

func TestAFailedPostLeavesTheApprovalAndAnUndoneRowInTheRecord(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	e.h.reviewPost = func(context.Context, string, string) error { return errors.New("the board is gone") }
	code, _ := e.approve(t)
	require.Equal(t, http.StatusInternalServerError, code)
	_, out := getActivity(t, act.URL, "", nil)
	rows := out["actions"].([]any)
	require.Len(t, rows, 2)
	assert.Equal(t, "undone", rows[0].(map[string]any)["action"])
	assert.Equal(t, "approve", rows[1].(map[string]any)["action"])
}

func TestTheHintIsPhoneOrNothingAndIgnoreAndSaveAreRecorded(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	for _, tc := range []struct{ decision, hint, want string }{{"save", "phone", "phone"}, {"unsave", "<b>x</b>", ""}, {"ignore", "", ""}} {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/board/alpha/artifacts/"+e.id+"/review", strings.NewReader(`{"decision":"`+tc.decision+`"}`))
		req.Header.Set("Content-Type", "application/json")
		if tc.hint != "" {
			req.Header.Set("X-Coral-Client", tc.hint)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, tc.decision)
		_, out := getActivity(t, act.URL, "?action="+tc.decision, nil)
		rows := out["actions"].([]any)
		require.Len(t, rows, 1, tc.decision)
		h, _ := rows[0].(map[string]any)["hint"].(string)
		assert.Equal(t, tc.want, h, tc.decision)
	}
	_, out := getActivity(t, act.URL, "?team=alpha&limit=2", nil)
	assert.Len(t, out["actions"].([]any), 2)
	_, out = getActivity(t, act.URL, "?team=nowhere", nil)
	assert.Empty(t, out["actions"])
}

func TestTheRecordIsTheOperatorsAloneAndNeverThroughTheHub(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	e.approve(t)
	notPerson := e.activityServer(t, false) // an agent token, a script: not a person
	code, _ := getActivity(t, notPerson.URL, "", nil)
	assert.Equal(t, http.StatusForbidden, code)
	act := e.activityServer(t, true)
	for name, hdr := range map[string]map[string]string{
		"a Hub stamp":  {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "someone"},
		"a forged one": {tunnel.ViaHeader: "not-the-secret", tunnel.HubUserHeader: "someone"},
	} {
		code, _ := getActivity(t, act.URL, "", hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
	for _, bad := range []string{"?action=bogus", "?before=-1", "?before=x", "?limit=0", "?team=../x"} {
		code, _ := getActivity(t, act.URL, bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	assert.NotEmpty(t, fmt.Sprint(tunnel.ViaHeader))
}

func TestTheActorLabelIsTheStableIdOrAHashNeverTheNameOrTheEmail(t *testing.T) {
	assert.Equal(t, "local", activityActor(callerIdentity{local: true, owner: true, pseudo: "local"}))
	id := "hub-uid-" + strings.Repeat("ab", 16)
	assert.Equal(t, "hub:"+id, activityActor(callerIdentity{owner: true, team: true, hubUserID: id, pseudo: "Rich"}), "the stable id is the label")
	got := activityActor(callerIdentity{owner: true, pseudo: "Rich Knorowski <rich@example.com>"})
	assert.True(t, strings.HasPrefix(got, "hub:"))
	assert.NotContains(t, got, "Rich")
	assert.NotContains(t, got, "@")
	assert.Equal(t, got, activityActor(callerIdentity{owner: true, pseudo: "Rich Knorowski <rich@example.com>"}), "the same account is the same label")
	assert.Equal(t, "hub:unknown", activityActor(callerIdentity{}), "a request that is not an authentic owner's names nobody")
	assert.Equal(t, "hub:unknown", activityActor(callerIdentity{pseudo: "Rich"}))
	// a request with a stamp that is not authentic is recorded as the Hub, by nobody
	forged := httptest.NewRequest("POST", "/", nil)
	forged.Header.Set(tunnel.ViaHeader, "not-the-secret")
	forged.Header.Set(tunnel.HubUserHeader, "Rich")
	m := activityMetaFor(forged, "", "")
	assert.Equal(t, "hub", m.Source)
	assert.Equal(t, "hub:unknown", m.Actor)
}

// The best-effort rows (#12069): a proposal's approve and reject, a goal the Operator closes, and nothing for an agent's own close.

func TestProposalsAreRecordedWithTheReasonAndARefusedActionLeavesNoRow(t *testing.T) {
	e := newProposalEnv(t)
	e.settings(t, board.BoardSettingsUpdate{GoalsNeedApproval: boolp(true)})
	_, a := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "outcome": "People use it", "subscriber_id": "Orchestrator"})
	_, b := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Rewrite everything", "outcome": "Why not", "subscriber_id": "Orchestrator"})
	ida, idb := int64(a["proposal_id"].(float64)), int64(b["proposal_id"].(float64))
	code, out := e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(ida)+"/approve", nil)
	require.Equal(t, http.StatusOK, code, out)
	code, out = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(idb)+"/reject", map[string]any{"reason": "Not this quarter"})
	require.Equal(t, http.StatusOK, code, out)
	rows, err := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "deny", rows[0].Action)
	assert.Equal(t, "proposal", rows[0].ItemKind)
	assert.Equal(t, itoa(idb), rows[0].ItemID)
	assert.Equal(t, "Not this quarter", rows[0].Note)
	assert.Equal(t, "Rewrite everything", rows[0].Title)
	assert.Equal(t, "approve", rows[1].Action)
	assert.Equal(t, "Ship the beta", rows[1].Title)
	assert.Equal(t, "team", rows[1].Team)
	chk, err := e.h.bs.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.True(t, chk.Intact)

	// an agent that asks for the same thing again is refused and leaves nothing
	before, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	code, _ = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(ida)+"/approve", nil)
	assert.NotEqual(t, http.StatusOK, code, "approved already")
	after, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	assert.Len(t, after, len(before), "a refused action leaves no row")
}

func TestAGoalTheOperatorClosesIsRecordedAndOneAnAgentClosesIsNot(t *testing.T) {
	e := newProposalEnv(t)
	r := chi.NewRouter()
	r.Post("/api/board/{project}/goals/{goalID}/close", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Test-Caller") == "person" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		e.h.CloseGoal(w, req)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	post := func(caller, goal int64, body string) int {
		req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/board/team/goals/%d/close", srv.URL, goal), strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if caller != 0 {
			req.Header.Set("X-Test-Caller", "person")
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	g1, err := e.h.bs.CreateGoal(context.Background(), "team", board.GoalInput{Title: "Agent closes this", Outcome: "o", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	g2, err := e.h.bs.CreateGoal(context.Background(), "team", board.GoalInput{Title: "Operator closes this", Outcome: "o", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, post(0, g1.ID, `{"reason":"shipped","subscriber_id":"Orchestrator"}`))
	rows, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	assert.Empty(t, rows, "an agent closing a goal is not the Operator's action")
	require.Equal(t, http.StatusOK, post(1, g2.ID, `{"reason":"not needed any more","subscriber_id":"Operator"}`))
	rows, _ = e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	require.Len(t, rows, 1)
	assert.Equal(t, "goal_close", rows[0].Action)
	assert.Equal(t, "goal", rows[0].ItemKind)
	assert.Equal(t, "Operator closes this", rows[0].Title)
	assert.Equal(t, "done: not needed any more", rows[0].Note)
}

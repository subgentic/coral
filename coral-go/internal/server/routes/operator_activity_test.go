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

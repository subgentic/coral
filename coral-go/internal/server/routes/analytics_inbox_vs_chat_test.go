package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12158: the Inbox-versus-chat read is counts and nothing else, the Operator's alone and this computer's, with the Operator's own comments among the Inbox's.

func ivcServer(t *testing.T, rig *cmtRig, person bool) *httptest.Server {
	t.Helper()
	h := NewInboxVsChatHandler(rig.h.bs, rig.ss)
	r := chi.NewRouter()
	r.Get("/api/analytics/inbox-vs-chat", func(w http.ResponseWriter, req *http.Request) {
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		h.Read(w, req)
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	return s
}

func getIVC(t *testing.T, base, query string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest("GET", base+"/api/analytics/inbox-vs-chat"+query, nil)
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

func TestTheInboxVsChatReadIsCountsWithTheOperatorsCommentsAmongTheInboxs(t *testing.T) {
	rig := newCmtRig(t)
	ctx := context.Background()
	meta := board.ActivityMeta{Actor: "local", Source: "local", Surface: "inbox"}
	require.NoError(t, rig.h.bs.RecordActivity(ctx, meta, board.ActApprove, "file", "secret-item-id", "", "team-a"))
	require.NoError(t, rig.h.bs.RecordOperatorTouchOn(ctx, "team-a", "Dev", board.TouchTyped, board.TouchLocal, "chat", time.Now()))
	// the Operator's own comment, through the real route
	code, c := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "a comment that must never be in the counts", "anchor": map[string]any{"whole": true}, "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, c)

	srv := ivcServer(t, rig, true)
	code, out := getIVC(t, srv.URL, "", nil)
	require.Equal(t, http.StatusOK, code, out)
	counts := out["counts"].(map[string]any)
	assert.Equal(t, float64(1), counts["inbox"].(map[string]any)["approve"])
	assert.Equal(t, float64(1), counts["inbox"].(map[string]any)["comment"], "the Operator's comment is the Inbox's")
	assert.Equal(t, float64(1), counts["chat"].(map[string]any)["typed"])
	assert.Equal(t, float64(28), out["days_asked"])
	raw, _ := json.Marshal(out)
	for _, never := range []string{"secret-item-id", "a comment that must never", "item_id", "body"} {
		assert.NotContains(t, string(raw), never, "counts only: no text and no id")
	}
	teams := counts["teams"].([]any)
	require.NotEmpty(t, teams)
	assert.Equal(t, "team-a", teams[0].(map[string]any)["team"])
	// one team
	_, one := getIVC(t, srv.URL, "?team=team-b", nil)
	assert.Empty(t, one["counts"].(map[string]any)["inbox"])
}

func TestTheInboxVsChatReadCutsDaysToNinetyAndRefusesWhatIsNotValid(t *testing.T) {
	rig := newCmtRig(t)
	srv := ivcServer(t, rig, true)
	_, out := getIVC(t, srv.URL, "?days=5000", nil)
	assert.Equal(t, float64(90), out["days_asked"], "the touches are kept 90 days: asked for more, it is cut")
	for _, bad := range []string{"?days=0", "?days=-3", "?days=x", "?team=../x", "?team=a b"} {
		code, _ := getIVC(t, srv.URL, bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

func TestTheInboxVsChatReadIsThePersonsAndThroughTheHubTheOwnersAloneAndNeverATeamsComputer(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	rig := newCmtRig(t)
	notPerson := ivcServer(t, rig, false) // an agent token or a script
	code, _ := getIVC(t, notPerson.URL, "", nil)
	assert.Equal(t, http.StatusForbidden, code)
	srv := ivcServer(t, rig, true)
	// through the Hub on a personal computer the owner reads it (read only) and nobody else does
	code, out := getIVC(t, srv.URL, "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"})
	require.Equal(t, http.StatusOK, code, out)
	assert.NotNil(t, out["counts"])
	for name, hdr := range map[string]map[string]string{
		"a Hub stamp, no owner marker": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "someone"},
		"another account's marker":     {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-9999ffff"},
		"a forged stamp":               {tunnel.ViaHeader: "not-the-secret", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"},
	} {
		code, _ := getIVC(t, srv.URL, "", hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
}

// On a computer enrolled to a Hub team each owner may read only their own rows, and the touches carry no actor: the counts of one owner cannot be told from another's, so nothing is shown through the Hub there.
func TestTheInboxVsChatReadIsRefusedThroughTheHubOnATeamsComputerEvenToItsOwners(t *testing.T) {
	withRecord(t, tunnel.OwnerKindTeam, teamOrgA, nil)
	withLabel(t, "", nil)
	rig := newCmtRig(t)
	srv := ivcServer(t, rig, true)
	flat := func(h http.Header) map[string]string {
		m := map[string]string{}
		for k := range h {
			m[k] = h.Get(k)
		}
		return m
	}
	for _, role := range []string{"admin", "owner", "member"} {
		code, out := getIVC(t, srv.URL, "", flat(teamStamp(teamOrgA, role, teamUIDA, teamUser)))
		assert.Equal(t, http.StatusForbidden, code, role)
		assert.NotContains(t, out, "counts", role+": nothing of the counts is in a refusal")
		if role != "member" {
			assert.Equal(t, "not_for_teams", out["code"], role)
		}
	}
	// the person at the team's own computer still reads it
	code, _ := getIVC(t, srv.URL, "", nil)
	assert.Equal(t, http.StatusOK, code)
}

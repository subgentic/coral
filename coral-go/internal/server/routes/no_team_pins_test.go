package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// QA Reviewer 2's pins on the no-team review files (#13532, #13539).

func decideNoTeamAs(h *BoardHandler, id, body string, hdr map[string]string, kind string) (int, map[string]any) {
	req := httptest.NewRequest(http.MethodPost, "/api/board/"+noTeamBoardID+"/artifacts/"+id+"/review", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", noTeamBoardID)
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.ReviewArtifact(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// Through Coral Hub the decision on a no-team file is the account's owner's alone: the owner's Approve is a 200 (and the agent is told once), a grantee is a 403 owner_only and nothing is decided.
func TestThroughTheHubOnlyTheOwnerDecidesOnANoTeamFile(t *testing.T) {
	h, mock, name, id, _ := noTeamNoticeRig(t)
	withLabel(t, ownerLabel, nil)

	code, out := decideNoTeamAs(h, id, `{"decision":"approve"}`, granteeHeaders(), callerHub)
	assert.Equal(t, http.StatusForbidden, code, "a grantee is refused: %v", out)
	assert.Equal(t, "owner_only", out["code"])
	tags, err := h.bs.ArtifactTags(context.Background(), noTeamBoardID)
	require.NoError(t, err)
	assert.Contains(t, tags[id], "for review", "nothing was decided by the refused request")

	code, out = decideNoTeamAs(h, id, `{"decision":"approve"}`, ownerHeaders(ownerLabel), callerHub)
	require.Equal(t, http.StatusOK, code, "the owner's Approve: %v", out)
	assert.Equal(t, "approved", out["state"])
	assert.Equal(t, true, out["delivered"], "the owner's decision tells the agent, as on this computer")
	assert.Len(t, mock.sentTo(name), 1, "and only the owner's request did: the refused grantee's typed nothing")
	tags, err = h.bs.ArtifactTags(context.Background(), noTeamBoardID)
	require.NoError(t, err)
	assert.NotContains(t, tags[id], "for review")
}

// The list of the files of agents on no team is cut to what the caller may read (#13527): an agent the read check cannot place gets none of them, the owner gets all.
func TestTheListOfNoTeamFilesIsCutToWhatTheCallerMayRead(t *testing.T) {
	h, _, _, _, _ := noTeamNoticeRig(t)
	list := func(agent bool) []string {
		req := httptest.NewRequest(http.MethodGet, "/api/team-artifacts", nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		if agent {
			req = withActor(req, Actor{Kind: ActorToken, Name: "stranger"}) // an agent token the identity layer did not bind to a session: no circle
		}
		rec := httptest.NewRecorder()
		h.ListAllTeamArtifacts(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out struct {
			Artifacts []struct {
				Name string `json:"name"`
			} `json:"artifacts"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		var names []string
		for _, a := range out.Artifacts {
			names = append(names, a.Name)
		}
		return names
	}
	assert.Equal(t, []string{"report.md"}, list(false), "the owner sees the no-team file")
	assert.Empty(t, list(true), "an agent that may not read it never sees it in the list")
}

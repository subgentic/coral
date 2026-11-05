package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator decides on a file a no-team agent sent for review (#13532): the board key is the reserved ~no-team, the file is one of the uploads of an agent on no team, Approve, Changes and Deny are recorded
// and leave Needs you, and, with no terminal to type into, nobody is told (the answer says so; no_team_notice_test.go covers the delivery). A file that is not a no-team upload of that key is still "no such artifact", a plain no-team file is not for review,
// and a request that is not a person's is refused as on any team.
func TestTheOperatorDecidesOnAFileANoTeamAgentSentForReview(t *testing.T) {
	_, h, coralDir := teamArtifactServer(t)
	h.SetTaskArtifactWriter(coralDir, nil)
	ctx := context.Background()
	review := writeUpload(t, coralDir, "solo-1", "the report", "report.md", "2026-10-09T10:00:00Z")
	plain := writeUpload(t, coralDir, "solo-1", "just notes", "notes.md", "2026-10-09T09:00:00Z")
	teamFile := writeUpload(t, coralDir, sessAlice, "alice's file", "alice.md", "2026-10-09T08:00:00Z")
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	_, err := h.bs.AddArtifactTags(ctx, noTeamBoardID, review, []string{"for review"})
	require.NoError(t, err)

	decide := func(person bool, id, body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/board/"+noTeamBoardID+"/artifacts/"+id+"/review", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
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

	code, out := decide(false, review, `{"decision":"approve"}`)
	assert.Equal(t, http.StatusForbidden, code, "a script is refused: %v", out)

	code, out = decide(true, review, `{"decision":"changes"}`)
	require.Equal(t, http.StatusOK, code, "Request changes on a No team file: %v", out)
	assert.Equal(t, "changes requested", out["state"])
	code, out = decide(true, review, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, "Approve: %v", out)
	assert.Equal(t, "approved", out["state"])
	assert.Equal(t, false, out["delivered"], "no terminal is wired in this rig: nobody could be told")
	assert.Equal(t, "failed", out["reason"])
	tags, err := h.bs.ArtifactTags(ctx, noTeamBoardID)
	require.NoError(t, err)
	assert.NotContains(t, tags[review], "for review", "it left Needs you")
	assert.Contains(t, tags[review], "approved")
	reviews, err := h.bs.ArtifactReviews(ctx, noTeamBoardID)
	require.NoError(t, err)
	assert.Equal(t, "approved", reviews[review].State)
	_ = time.Now

	code, _ = decide(true, plain, `{"decision":"approve"}`)
	assert.Equal(t, http.StatusConflict, code, "a no-team file that was not sent for review is not for review")
	code, _ = decide(true, teamFile, `{"decision":"approve"}`)
	assert.Equal(t, http.StatusNotFound, code, "a team's file is not a no-team file")
	code, _ = decide(true, strings.Repeat("a", 64), `{"decision":"approve"}`)
	assert.Equal(t, http.StatusNotFound, code, "an unknown file")
}

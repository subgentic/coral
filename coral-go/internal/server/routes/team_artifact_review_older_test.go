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

// Approving a newer version closes the older versions' review rows (#18166, walk F5): v1 stayed in Needs you after v2 was approved.
func TestApprovingANewerVersionClosesTheOlderVersionsReviewRow(t *testing.T) {
	k := newKindRig(t)
	root, err := k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR the plan", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "the plan, version one", "&name=plan.md")
	require.Equal(t, 201, code, out)
	v1 := digestOfURI(out["uri"].(string))
	code, out = k.upTask("s1", root.ID, "the plan, version two", "&name=plan.md")
	require.Equal(t, 201, code, out)
	require.EqualValues(t, 2, out["version"], out)
	v2 := digestOfURI(out["uri"].(string))
	// v1 is waiting again (a reopened row, as the walk found it): both versions are for review
	_, err = k.h.bs.AddArtifactTags(context.Background(), "alpha", v1, []string{"for review"})
	require.NoError(t, err)
	tagsOf := func(id string) []string {
		all, err := k.h.bs.ArtifactTags(context.Background(), "alpha")
		require.NoError(t, err)
		return all[id]
	}
	require.Contains(t, tagsOf(v1), "for review")

	req := httptest.NewRequest(http.MethodPost, "/api/board/alpha/artifacts/"+v2+"/review", strings.NewReader(`{"decision":"approve"}`))
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("project", "alpha")
	rc.URLParams.Add("id", v2)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	bh := NewBoardHandler(k.h.bs)
	bh.SetTaskArtifactWriter(k.coralDir, nil)
	bh.ReviewArtifact(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	require.Equal(t, http.StatusOK, rec.Code, body)

	assert.NotContains(t, tagsOf(v1), "for review", "v1's row leaves Needs you")
	assert.Contains(t, tagsOf(v1), "superseded")
	assert.Contains(t, tagsOf(v2), "approved")
}

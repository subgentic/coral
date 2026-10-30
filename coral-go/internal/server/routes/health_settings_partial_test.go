package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

// coral-hub's #133486: a health body that names only some settings changes only those; every setting it leaves out, at every depth, keeps its stored value (before, the whole object was
// replaced and each one left out took its default, so one short request could switch every check off).
func TestAPartialHealthBodyChangesOnlyWhatItNames(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Put("/api/board/{project}/settings", h.UpdateBoardSettings)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	ctx := context.Background()
	for _, s := range []struct{ id, title string }{{"Orchestrator", "Orchestrator"}, {"Dev", "Developer"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	url := server.URL + "/api/board/team/settings"

	// A configured team: the check on, every optional line on, its own intervals.
	start := board.DefaultHealthSettings()
	start.On, start.AllClear, start.IntervalMin, start.Recipient = true, true, 17, "Dev"
	start.ClaimNudge.On, start.ClaimNudge.AfterMin, start.ClaimNudge.Nudges = true, 7, 3
	start.StatusNudge.On, start.StatusNudge.AfterMin = true, 41
	start.MentionRenudge.On, start.MentionRenudge.AfterMin = true, 13
	start.AutoDelegate.On = true
	start.PostNoTask.On = true
	start.GoalSize.On = true
	start.DefaultReviewers = []string{"Dev"}
	start.GoalsReady.On, start.GoalsReady.WaitMin = true, 90
	require.NoError(t, h.bs.SetHealthSettings(ctx, "team", start))
	want := h.bs.GetHealthSettings(ctx, "team") // what is stored, clamped

	// The partial body: one field of one sub-object.
	code, out := putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": map[string]any{"claim_nudge": map[string]any{"after_min": 11}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	want.ClaimNudge.AfterMin = 11
	assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"), "only claim_nudge.after_min changed: the check, its recipient, every other sub-object and claim_nudge's own other fields are as stored")

	// A top-level field alone.
	code, out = putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": map[string]any{"all_clear": false}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	want.AllClear = false
	assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"))

	// A sub-object's switch turned off by name; the rest of it stays.
	code, out = putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": map[string]any{"status_nudge": map[string]any{"on": false}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	want.StatusNudge.On = false
	assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"), "status_nudge keeps its after_min")

	// An empty health object, and no health key, change nothing; the other settings of the body are applied as before.
	for _, body := range []map[string]any{{"health": map[string]any{}}, {"require_goal": true}} {
		body["subscriber_id"] = "Operator"
		code, out = putSettings(t, url, body)
		require.Equal(t, http.StatusOK, code, "%v", out)
		assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"), "%v", body)
	}
	bsettings, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.True(t, bsettings.RequireGoal)

	// A value that is checked is checked when it is named: a recipient who is not a member is refused, and nothing changes; one who is not named is not asked about again.
	code, _ = putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": map[string]any{"recipient": "Nobody", "claim_nudge": map[string]any{"after_min": 30}}})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"), "a refused body changes none of it")
	_, err = h.bs.Unsubscribe(ctx, "team", "Dev") // the stored recipient leaves the team
	require.NoError(t, err)
	code, out = putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": map[string]any{"claim_nudge": map[string]any{"after_min": 12}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	want.ClaimNudge.AfterMin = 12
	assert.Equal(t, want, h.bs.GetHealthSettings(ctx, "team"))

	// The full body behaves as it did: every setting it carries is stored, and a list in it replaces the stored one.
	full := board.DefaultHealthSettings()
	full.On, full.IntervalMin = true, 20
	full.DefaultReviewers = []string{"Orchestrator"}
	code, out = putSettings(t, url, map[string]any{"subscriber_id": "Operator", "health": full})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, full.Clamp(), h.bs.GetHealthSettings(ctx, "team"))

	// The route's tier and class are unchanged.
	assert.Equal(t, tunnel.TierLaunch, tunnel.Classify(http.MethodPut, "/api/board/team/settings", ""))
	assert.NotEmpty(t, operatorOnlyRoutes["PUT /api/board/{project}/settings"])
}

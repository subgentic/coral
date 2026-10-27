package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8957 (Goal #80): the review pool through the routes: an agent's Reviews only setting (the Operator's), submit-review with areas, the claim, and the Needs review page.

func putCode(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(b))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func getCode(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

// poolTeam is reviewTeam with the two reviewers set to review only: "Security Reviewer" for security and go, "QA Engineer" for every area.
func poolTeam(t *testing.T, project string) (base func(int64, string) string, h *BoardHandler, task *board.Task, root string) {
	t.Helper()
	base, h, task = reviewTeam(t, project, true)
	root = strings.TrimSuffix(base(0, "x"), "/tasks/0/x")
	code, out := putCode(t, root+"/subscribers/Security%20Reviewer/review-settings", map[string]any{"reviews_only": true, "review_areas": []string{"Security", "go"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = putCode(t, root+"/subscribers/QA%20Engineer/review-settings", map[string]any{"reviews_only": true})
	require.Equal(t, http.StatusOK, code, "%v", out)
	return base, h, task, root
}

func TestReviewSettingsRouteSetsAndShowsAnAgentsReviewSetting(t *testing.T) {
	_, h, _, root := poolTeam(t, "settings")
	code, out := putCode(t, root+"/subscribers/Security%20Reviewer/review-settings", map[string]any{"review_areas": []string{"UI", "ui", "docs"}})
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, map[string]any{"subscriber_id": "Security Reviewer", "reviews_only": true, "review_areas": []any{"ui", "docs"}}, out, "only the sent key changed; the areas are normalised")

	// the members list shows both fields
	resp, err := http.Get(root + "/subscribers")
	require.NoError(t, err)
	defer resp.Body.Close()
	var subs []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&subs))
	seen := map[string]map[string]any{}
	for _, s := range subs {
		seen[s["subscriber_id"].(string)] = s
	}
	assert.Equal(t, true, seen["Security Reviewer"]["reviews_only"])
	assert.Equal(t, []any{"ui", "docs"}, seen["Security Reviewer"]["review_areas"])
	assert.Equal(t, false, seen["worker"]["reviews_only"], "everyone else is as before")
	assert.Equal(t, []any{}, seen["worker"]["review_areas"], "an empty array")

	for name, c := range map[string]struct {
		who  string
		body any
		want int
	}{
		"a bad area":        {"Security%20Reviewer", map[string]any{"review_areas": []string{"not an area"}}, http.StatusBadRequest},
		"too many areas":    {"Security%20Reviewer", map[string]any{"review_areas": []string{"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"}}, http.StatusBadRequest},
		"nothing to change": {"Security%20Reviewer", map[string]any{}, http.StatusBadRequest},
		"not a member":      {"Nobody", map[string]any{"reviews_only": true}, http.StatusNotFound},
	} {
		code, out := putCode(t, root+"/subscribers/"+c.who+"/review-settings", c.body)
		assert.Equal(t, c.want, code, "%s: %v", name, out)
	}
	sub, err := h.bs.GetProjectSubscription(context.Background(), "settings", "Security Reviewer")
	require.NoError(t, err)
	assert.Equal(t, []string{"ui", "docs"}, sub.ReviewAreas.Slice(), "a refused change changed nothing")
}

func TestSubscribingCannotSetTheReviewSetting(t *testing.T) {
	base, h, _ := reviewTeam(t, "selfset", true)
	root := strings.TrimSuffix(base(0, "x"), "/tasks/0/x")
	resp := postJSON(t, root+"/subscribe", map[string]any{"subscriber_id": "worker", "job_title": "Backend Dev", "reviews_only": true, "review_areas": []string{"go"}})
	resp.Body.Close()
	sub, err := h.bs.GetProjectSubscription(context.Background(), "selfset", "worker")
	require.NoError(t, err)
	require.NotNil(t, sub)
	assert.False(t, sub.ReviewsOnly, "an agent joining does not mark itself as a reviewer: that is the Operator's setting")
	assert.Empty(t, sub.ReviewAreas.Slice())
}

func TestReviewSettingsRouteRefusesATunneledNonOwner(t *testing.T) {
	withRecord(t, "team", teamOrgA, nil)
	h := &BoardHandler{}
	for name, hdr := range map[string]http.Header{
		"a member of the organisation":      teamStamp(teamOrgA, "member", teamUIDA, teamUser),
		"an admin of another organisation":  teamStamp(teamOrgB, "admin", teamUIDA, teamUser),
		"the stamp of a hub viewer, no uid": teamStamp(teamOrgA, "member", "", teamUser),
	} {
		req := httptest.NewRequest(http.MethodPut, "/api/board/alpha/subscribers/Rev/review-settings", strings.NewReader(`{"reviews_only":true}`))
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "alpha")
		rctx.URLParams.Add("subscriberID", "Rev")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		require.NotPanics(t, func() { h.SetReviewSettings(rec, req) }, name)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.Equal(t, "owner_only", decodeStrings(t, rec.Body.String())["code"], name)
	}
}

func submitWith(t *testing.T, base func(int64, string) string, id int64, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"subscriber_id": "worker", "reason": "ready", "message": "built it", "artifacts": []board.TaskArtifact{{Name: "report", Content: "done"}}}
	for k, v := range extra {
		body[k] = v
	}
	return postCode(t, base(id, "submit-review"), body)
}

func boardText(t *testing.T, h *BoardHandler, project string) string {
	t.Helper()
	msgs, err := h.bs.ListMessages(context.Background(), project, 200, 0, 0)
	require.NoError(t, err)
	var all []string
	for _, m := range msgs {
		all = append(all, m.Content)
	}
	return strings.Join(all, "\n")
}

func TestSubmitReviewPutsTheReviewInThePoolAndNamesWhoItFits(t *testing.T) {
	base, h, task, _ := poolTeam(t, "pool")
	code, out := submitWith(t, base, task.ID, map[string]any{"areas": []string{"go", "Docs"}, "reviewers": 2})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, err := h.bs.GetTask(context.Background(), "pool", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "review_pending", got.Status)
	assert.True(t, got.Workflow.ReviewInPool)
	assert.Equal(t, []string{"go", "docs"}, got.Workflow.ReviewAreas)
	assert.Equal(t, 2, got.Workflow.ReviewersWanted)
	assert.Equal(t, "lead", *got.AssignedTo, "the orchestrator still holds it and can name reviewers")
	text := boardText(t, h, "pool")
	assert.Contains(t, text, fmt.Sprintf("[Task #%d in the review pool]", task.ID))
	assert.Contains(t, text, "@Security Reviewer", "covers go")
	assert.Contains(t, text, "@QA Engineer", "covers every area")
	assert.NotContains(t, text, fmt.Sprintf("[Task #%d in review]", task.ID), "the orchestrator is not asked to route it")
}

func TestSubmitReviewWithABadAreaRecordsNothing(t *testing.T) {
	base, h, task, _ := poolTeam(t, "badarea")
	code, out := submitWith(t, base, task.ID, map[string]any{"areas": []string{"not an area"}})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	code, _ = submitWith(t, base, task.ID, map[string]any{"reviewers": 3})
	assert.Equal(t, http.StatusBadRequest, code)
	got, err := h.bs.GetTask(context.Background(), "badarea", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "in_progress", got.Status, "refused before the candidate was recorded")
	assert.Nil(t, got.Workflow.CompletionReview)
}

func TestSubmitReviewTakesTheAreasFromThePathsWhenNoneAreNamed(t *testing.T) {
	base, h, task, _ := poolTeam(t, "paths")
	code, out := submitWith(t, base, task.ID, map[string]any{"paths": []string{"coral-go/internal/board/review_pool.go", "coral-go/pkg/tunnel/routes.go", "coral-go/agent_docs/teams.md"}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	got, err := h.bs.GetTask(context.Background(), "paths", task.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{"docs", "go", "security"}, got.Workflow.ReviewAreas)
}

func TestReviewAreasFromPaths(t *testing.T) {
	for _, c := range []struct {
		paths []string
		want  []string
	}{
		{[]string{"coral-go/internal/board/x.go"}, []string{"go"}},
		{[]string{"coral-go/pkg/frontend/static/a.js", "coral-go/pkg/frontend/static/css/a.css"}, []string{"ui"}},
		{[]string{"tests/frontend/a.test.js"}, []string{"ui"}},
		{[]string{"coral-go/agent_docs/teams.md", "README.md"}, []string{"docs"}},
		{[]string{".github/workflows/release.yml", "installers/build-linux.sh"}, []string{"release"}},
		{[]string{"coral-go/internal/auth/x.go", "coral-go/pkg/redact/y.go"}, []string{"go", "security"}},
		{[]string{`coral-go\internal\board\x.go`}, []string{"go"}},
		{nil, []string{}},
		{[]string{"LICENSE"}, []string{}},
	} {
		assert.Equal(t, c.want, reviewAreasFromPaths(c.paths), "%v", c.paths)
	}
}

func TestAReviewOnlyAgentClaimsFromThePoolAndIsRefusedABuildTask(t *testing.T) {
	base, h, task, root := poolTeam(t, "claim")
	ctx := context.Background()
	code, out := submitWith(t, base, task.ID, map[string]any{"areas": []string{"go"}})
	require.Equal(t, http.StatusOK, code, "%v", out)

	// a build task named to a review-only agent is refused with a code
	build, err := h.bs.CreateTask(ctx, "claim", "A build", "", "high", "lead", "QA Engineer")
	require.NoError(t, err)
	code, out = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "QA Engineer", "task_id": build.ID})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "reviews_only", out["code"])
	assert.Contains(t, fmt.Sprint(out["error"]), "Reviews only")

	// with no id it takes the oldest review that matches
	code, out = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "Security Reviewer"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "in_progress", out["status"])
	assert.Equal(t, "Security Reviewer", out["assigned_to"])
	assert.Contains(t, fmt.Sprint(out["title"]), "Review #")
	// and holds it: a second claim is refused as for any task
	code, _ = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "Security Reviewer"})
	assert.Equal(t, http.StatusConflict, code)
	// the author cannot take it, and nothing else matches for QA Engineer once it is taken
	code, _ = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "QA Engineer"})
	assert.Equal(t, http.StatusNotFound, code, "no pooled review is left, and a build task is not offered to a review-only agent")
}

func TestNeedsReviewPageListsTheWaitingReviewsWithTheirPoolFields(t *testing.T) {
	base, h, task, root := poolTeam(t, "needs")
	ctx := context.Background()
	code, out := submitWith(t, base, task.ID, map[string]any{"areas": []string{"ui", "go"}, "reviewers": 2})
	require.Equal(t, http.StatusOK, code, "%v", out)
	other, err := h.bs.CreateTask(ctx, "needs", "Not in review", "", "low", "lead", "worker")
	require.NoError(t, err)

	code, page := getCode(t, root+"/tasks?needs_review=true")
	require.Equal(t, http.StatusOK, code)
	tasks := page["tasks"].([]any)
	require.Len(t, tasks, 1, "only what waits for a review")
	item := tasks[0].(map[string]any)
	assert.EqualValues(t, task.ID, item["id"])
	assert.Equal(t, "review_pending", item["status"])
	assert.Equal(t, true, item["review_in_pool"])
	assert.Equal(t, []any{"ui", "go"}, item["review_areas"])
	assert.EqualValues(t, 2, item["reviewers_wanted"])

	// the ordinary list carries the same fields on the same item, and none on the others
	code, page = getCode(t, root+"/tasks")
	require.Equal(t, http.StatusOK, code)
	for _, ti := range page["tasks"].([]any) {
		m := ti.(map[string]any)
		if int64(m["id"].(float64)) == other.ID {
			assert.Nil(t, m["review_in_pool"])
			assert.Nil(t, m["review_areas"])
		} else {
			assert.Equal(t, true, m["review_in_pool"])
		}
	}
	// false changes nothing; anything else, or a combination, is refused
	code, page = getCode(t, root+"/tasks?needs_review=false")
	assert.Equal(t, http.StatusOK, code)
	assert.Greater(t, len(page["tasks"].([]any)), 1)
	for _, bad := range []string{"needs_review=yes", "needs_review=true&status=open", "needs_review=true&cursor=x"} {
		code, _ = getCode(t, root+"/tasks?"+bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	// once a reviewer holds the last place the pool closes, and the page says so
	code, _ = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "Security Reviewer"})
	require.Equal(t, http.StatusOK, code)
	_, page = getCode(t, root+"/tasks?needs_review=true")
	assert.Equal(t, true, page["tasks"].([]any)[0].(map[string]any)["review_in_pool"], "two reviewers wanted: one place is still open")
	code, _ = postCode(t, root+"/tasks/claim", map[string]any{"subscriber_id": "QA Engineer"})
	require.Equal(t, http.StatusOK, code)
	_, page = getCode(t, root+"/tasks?needs_review=true")
	assert.Nil(t, page["tasks"].([]any)[0].(map[string]any)["review_in_pool"], "both places taken: no longer in the pool")
}

// A team launch may carry each member's review setting (#8957). A bad area is refused before any member starts, and through Coral Hub the settings are not offered.
func TestLaunchTeamChecksTheMembersReviewSettings(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	cfg := &config.Config{LogDir: t.TempDir()}
	cfg.UseCoralDir(t.TempDir())
	handler := NewSessionsHandler(db, cfg, nil, newMockTerminal(), bs)
	launch := func(agent map[string]any, hdr http.Header) *httptest.ResponseRecorder {
		b, _ := json.Marshal(map[string]any{"board_name": "poolteam", "working_dir": t.TempDir(), "agents": []map[string]any{{"name": "Orchestrator", "prompt": "lead"}, agent}})
		req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(b))
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		rec := httptest.NewRecorder()
		handler.LaunchTeam(rec, req)
		return rec
	}
	rec := launch(map[string]any{"name": "Reviewer", "prompt": "review", "reviews_only": true, "review_areas": []string{"not an area"}}, nil)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), `agent \"Reviewer\"`)
	assert.Contains(t, rec.Body.String(), "not an area")
	rec = launch(map[string]any{"name": "Reviewer", "prompt": "review", "review_areas": []string{"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"}}, nil)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "more than eight areas")

	withRecord(t, "team", teamOrgA, nil)
	rec = launch(map[string]any{"name": "Reviewer", "prompt": "review", "reviews_only": true}, teamStamp(teamOrgA, "admin", teamUIDA, teamUser))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "not offered through Coral Hub")
	boards, err := bs.ListSubscribers(context.Background(), "poolteam")
	require.NoError(t, err)
	assert.Empty(t, boards, "nothing was launched or subscribed")
}

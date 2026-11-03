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
)

// #12144 (the Operator's design v6, slice 1): what reaches Needs you follows the settings. A file for review has a kind; a kind switched off, or a team not included, mutes it: in its folder, under the Muted
// line, not counted and not pushed. Questions and decisions have no switch.
type inboxEnv struct {
	*reviewEnv
	settings map[string]string
}

func newInboxEnv(t *testing.T) *inboxEnv {
	t.Helper()
	e := &inboxEnv{reviewEnv: newReviewEnv(t, true), settings: map[string]string{}}
	e.h.SetInboxSettings(func(context.Context) (map[string]string, error) {
		cp := map[string]string{}
		for k, v := range e.settings {
			cp[k] = v
		}
		return cp, nil
	})
	e.tag(t, `["for review"]`)
	return e
}

func (e *inboxEnv) kind(t *testing.T, kind string) {
	t.Helper()
	_, err := e.h.bs.SetArtifactKind(context.Background(), "alpha", e.id, kind, "sess", time.Now())
	require.NoError(t, err)
}

func (e *inboxEnv) needsYou(t *testing.T) map[string]any {
	t.Helper()
	req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	w := httptest.NewRecorder()
	e.h.NeedsYou(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	return out
}

func (e *inboxEnv) count(t *testing.T) int { return int(e.needsYou(t)["count"].(float64)) }

func (e *inboxEnv) ask(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	q, err := e.h.bs.PostMessage(ctx, "alpha", "Alice", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, e.h.bs.RecordAsk(ctx, "alpha", q, []string{"Operator"}))
}

func (e *inboxEnv) operatorList(t *testing.T) map[string]any {
	t.Helper()
	req := asPerson(httptest.NewRequest(http.MethodGet, "/api/board/alpha/artifacts?tag=for%20review", nil))
	req = withProject(req, "alpha")
	w := httptest.NewRecorder()
	e.h.ListTeamArtifacts(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out struct {
		Artifacts []map[string]any `json:"artifacts"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.NotEmpty(t, out.Artifacts)
	return out.Artifacts[0]
}

func TestAKindSwitchedOffIsNotCountedListedOrPushedButStaysInItsFolder(t *testing.T) {
	for _, kind := range []string{"file", "done", "release", "decided", "digest"} {
		kind := kind
		t.Run(kind, func(t *testing.T) {
			e := newInboxEnv(t)
			e.kind(t, kind)
			out := e.needsYou(t)
			require.EqualValues(t, 1, out["count"], "on by default: it counts")
			assert.Len(t, needsYouItems(out), 1)
			assert.Nil(t, out["muted"])
			e.settings["inbox_kind_"+kind] = "false"
			out = e.needsYou(t)
			assert.EqualValues(t, 0, out["count"], "switched off: not counted")
			assert.Empty(t, needsYouItems(out), "and not listed, so not pushed")
			assert.EqualValues(t, 1, out["muted"].(map[string]any)[kind], "the muted count says what was left out")
			row := e.operatorList(t)
			assert.Equal(t, true, row["muted"], "its folder (the list) still has it, marked muted")
			assert.Equal(t, "plan.md", row["name"])
			e.settings["inbox_kind_"+kind] = "true"
			assert.Equal(t, 1, e.count(t), "switched back on")
		})
	}
}

func TestOnlyTheKindSwitchedOffIsMuted(t *testing.T) {
	e := newInboxEnv(t)
	e.kind(t, "release")
	e.settings["inbox_kind_done"] = "false"
	e.settings["inbox_kind_file"] = "false"
	assert.Equal(t, 1, e.count(t), "the other kinds' switches do not mute a release summary")
	e.settings["inbox_kind_release"] = "false"
	assert.Equal(t, 0, e.count(t))
}

func TestAnUnincludedTeamHasItsOptionalKindsMutedAndAnIncludedOneDoesNot(t *testing.T) {
	e := newInboxEnv(t)
	e.settings["inbox_included_teams"] = `["somebody-else"]`
	out := e.needsYou(t)
	assert.EqualValues(t, 0, out["count"], "a team that is not included: its files are muted")
	assert.EqualValues(t, 1, out["muted"].(map[string]any)["file"])
	e.settings["inbox_included_teams"] = `["alpha"]`
	assert.Equal(t, 1, e.count(t), "included")
	e.settings["inbox_included_teams"] = "all"
	assert.Equal(t, 1, e.count(t))
	e.settings["inbox_included_teams"] = "not json at all"
	assert.Equal(t, 1, e.count(t), "a value nobody can read leaves every team included: it never mutes by mistake")
}

// Security's rule: a question posted while every kind is switched off, and while its team is not included, is still counted and listed (and so badged and pushed). Nothing in the settings can mute it.
func TestAQuestionIsNeverMutedByAnySwitchOrTeamChoice(t *testing.T) {
	e := newInboxEnv(t)
	for _, k := range []string{"file", "done", "release", "decided", "digest"} {
		e.settings["inbox_kind_"+k] = "false"
	}
	e.settings["inbox_included_teams"] = `["somebody-else"]`
	e.ask(t)
	out := e.needsYou(t)
	assert.EqualValues(t, 1, out["count"], "only the question counts: the file is muted, the question is not")
	items := needsYouItems(out)
	require.Len(t, items, 1)
	assert.Equal(t, "question", items[0]["kind"])
	assert.EqualValues(t, 1, out["counts"].(map[string]any)["question"])
}

// An agent's own read of the list learns nothing of what the Operator muted.
func TestAnAgentsListHasNoKindAndNoMuteMark(t *testing.T) {
	e := newInboxEnv(t)
	e.kind(t, "release")
	e.settings["inbox_kind_release"] = "false"
	req := httptest.NewRequest(http.MethodGet, "/api/board/alpha/artifacts?tag=for%20review", nil)
	req = withProject(req, "alpha")
	w := httptest.NewRecorder()
	e.h.ListTeamArtifacts(w, req)
	assert.NotContains(t, w.Body.String(), `"muted"`)
	assert.NotContains(t, w.Body.String(), `"kind"`)
}

func TestTheKindOfAFileIsWrittenOnceAndAPlainFileHasNone(t *testing.T) {
	e := newInboxEnv(t)
	ctx := context.Background()
	k, err := e.h.bs.ArtifactKind(ctx, "alpha", e.id)
	require.NoError(t, err)
	assert.Equal(t, board.KindFile, k, "no row is a file")
	got, err := e.h.bs.SetArtifactKind(ctx, "alpha", e.id, board.KindRelease, "s1", time.Now())
	require.NoError(t, err)
	assert.Equal(t, board.KindRelease, got)
	got, err = e.h.bs.SetArtifactKind(ctx, "alpha", e.id, board.KindDone, "s2", time.Now())
	require.NoError(t, err)
	assert.Equal(t, board.KindRelease, got, "the same bytes uploaded again cannot change the kind")
	got, err = e.h.bs.SetArtifactKind(ctx, "alpha", e.id, board.KindFile, "s2", time.Now())
	require.NoError(t, err)
	assert.Equal(t, board.KindRelease, got, "and a plain upload does not clear it")
}

func withProject(r *http.Request, project string) *http.Request {
	rc := chi.NewRouteContext()
	rc.URLParams.Add("project", project)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rc))
}

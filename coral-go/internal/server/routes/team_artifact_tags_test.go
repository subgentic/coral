package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8583 (Goal #61): artifact tags on the team's artifacts: on each row, a filter, the team's counts, the Operator's set-tags route, and the tags an agent asks for.

type tagEnv struct {
	srv      *httptest.Server
	h        *BoardHandler
	coralDir string
	ids      map[string]string // the stored objects by name
}

func newTagEnv(t *testing.T) *tagEnv {
	t.Helper()
	srv, h, coralDir := teamArtifactServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/artifacts", h.ListTeamArtifacts)
	r.Put("/api/board/{project}/artifacts/{id}/tags", h.SetArtifactTags)
	put := httptest.NewServer(r)
	t.Cleanup(put.Close)
	e := &tagEnv{srv: put, h: h, coralDir: coralDir, ids: map[string]string{}}
	_ = srv
	for _, f := range []struct{ name, text string }{{"report.md", "# the report"}, {"scratch.log", "scratch"}, {"final.pdf", "final bytes"}} {
		id := storeManagedArtifact(t, coralDir, f.text, true, true)
		e.ids[f.name] = id
	}
	for name, id := range e.ids {
		completeWithArtifacts(t, h, "tag-team", "Make "+name, []board.TaskArtifact{{Name: name, URI: "coral://artifacts/" + id}})
	}
	return e
}

func (e *tagEnv) put(t *testing.T, project, id, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/"+project+"/artifacts/"+id+"/tags", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *tagEnv) list(t *testing.T, query string, want int) map[string]any {
	t.Helper()
	resp, err := http.Get(e.srv.URL + "/api/board/tag-team/artifacts?" + query)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, want, resp.StatusCode)
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func namesOf(out map[string]any) []string {
	var names []string
	rows, _ := out["artifacts"].([]any)
	for _, r := range rows {
		names = append(names, r.(map[string]any)["name"].(string))
	}
	return names
}

func TestTheOperatorTagsATeamArtifactAndTheListShowsIt(t *testing.T) {
	e := newTagEnv(t)
	code, out := e.put(t, "tag-team", e.ids["report.md"], `{"tags": ["For  Review", "internal", "for review"]}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, []any{"for review", "internal"}, out["tags"], "normalised, once each")

	list := e.list(t, "limit=50", http.StatusOK)
	rows := list["artifacts"].([]any)
	require.Len(t, rows, 3)
	for _, r := range rows {
		row := r.(map[string]any)
		if row["name"] == "report.md" {
			requireKeys(t, "a tagged artifact", row, "id", "name", "tags")
			assert.Equal(t, []any{"for review", "internal"}, row["tags"])
		} else {
			assert.NotContains(t, row, "tags", "an untagged artifact sends no key")
		}
	}

	code, out = e.put(t, "tag-team", e.ids["report.md"], `{"tags": ["final"]}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, []any{"final"}, out["tags"], "set replaces")
	code, out = e.put(t, "tag-team", e.ids["report.md"], `{"tags": []}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Empty(t, out["tags"], "an empty set clears")
}

func TestSetTagsRefusesWhatIsNotATagOrNotTheTeams(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	for name, body := range map[string]string{
		"a bad word":    `{"tags": ["no way!"]}`,
		"too long":      `{"tags": ["` + strings.Repeat("a", 25) + `"]}`,
		"six":           `{"tags": ["a","b","c","d","e","f"]}`,
		"not a list":    `{"tags": "internal"}`,
		"not JSON":      `tags`,
		"an empty word": `{"tags": [""]}`,
	} {
		code, out := e.put(t, "tag-team", id, body)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	code, _ := e.put(t, "tag-team", "not-a-hex-id", `{"tags": ["a"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "an id that is not an object id")
	code, _ = e.put(t, "tag-team", strings.Repeat("a", 64), `{"tags": ["a"]}`)
	assert.Equal(t, http.StatusNotFound, code, "an object the team has no use of")
	code, _ = e.put(t, "another-team", id, `{"tags": ["a"]}`)
	assert.Equal(t, http.StatusNotFound, code, "another team's board does not hold it")
	tags, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
	require.NoError(t, err)
	assert.Empty(t, tags, "nothing was stored by a refused request")
}

func TestTheTagFilterTakesAnyOfTheWordsAndTheQueryCountsThem(t *testing.T) {
	e := newTagEnv(t)
	ctx := context.Background()
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", e.ids["report.md"], []string{"for review", "internal"}))
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", e.ids["scratch.log"], []string{"internal"}))
	require.NoError(t, e.h.bs.SetArtifactTags(ctx, "tag-team", e.ids["final.pdf"], []string{"final"}))

	assert.ElementsMatch(t, []string{"report.md"}, namesOf(e.list(t, "tag=for+review", http.StatusOK)))
	assert.ElementsMatch(t, []string{"report.md", "scratch.log"}, namesOf(e.list(t, "tag=internal", http.StatusOK)))
	assert.ElementsMatch(t, []string{"report.md", "scratch.log", "final.pdf"}, namesOf(e.list(t, "tag=for+review&tag=internal&tag=final", http.StatusOK)), "any of")
	assert.ElementsMatch(t, []string{"report.md"}, namesOf(e.list(t, "tag=FOR++Review", http.StatusOK)), "the word is normalised as a stored one is")
	assert.Empty(t, namesOf(e.list(t, "tag=draft", http.StatusOK)))
	assert.ElementsMatch(t, []string{"scratch.log"}, namesOf(e.list(t, "tag=internal&q=scratch", http.StatusOK)), "joins the other filters")

	out := e.list(t, "tag=for+review", http.StatusOK)
	assert.EqualValues(t, 1, out["total"], "a query: a total")
	assert.Equal(t, map[string]any{"for review": float64(1), "internal": float64(2), "final": float64(1)}, out["tag_counts"], "the team's words with their counts, whatever the filter")

	for _, bad := range []string{"tag=no+way%21", "tag=" + strings.Repeat("a", 25), "tag=", "tag=a,,b"} {
		e.list(t, bad, http.StatusBadRequest)
	}
	// a cursor of one tag filter is refused for another
	first := e.list(t, "tag=internal&limit=1", http.StatusOK)
	cursor, _ := first["next_cursor"].(string)
	require.NotEmpty(t, cursor)
	e.list(t, "tag=final&limit=1&cursor="+cursor, http.StatusBadRequest)
}

// The tags an agent asks for in a task result's manifest are the team's tags of the stored objects it links, added to what they have, and are not kept in the row.
func TestManifestTagsAreAppliedToTheLinkedObjects(t *testing.T) {
	e := newTagEnv(t)
	ctx := context.Background()
	id := e.ids["report.md"]
	e.uploadedBy(t, "sess-dev", id)
	arts := []board.TaskArtifact{
		{Name: "report.md", URI: "coral://artifacts/" + id, Tags: []string{"For Review", "no way!", "internal"}, Question: "Approve the Q4 report?"},
		{Name: "inline.md", Content: "x", Tags: []string{"internal"}}, // nothing to tag: not a stored object
		{Name: "unverified", URI: "coral://artifacts/" + e.ids["scratch.log"], Provenance: provenanceUnverified, Tags: []string{"final"}},
	}
	e.h.applyManifestTags(ctx, "tag-team", "sess-dev", false, arts)
	for _, a := range arts {
		assert.Nil(t, a.Tags, "the row keeps no tags: %s", a.Name)
	}
	tags, err := e.h.bs.ArtifactTags(ctx, "tag-team")
	require.NoError(t, err)
	assert.Equal(t, map[string][]string{id: {"for review", "internal"}}, tags, "a word that is not a tag left out; an unverified link and inline content are not tagged")
	qs, err := e.h.bs.ArtifactQuestions(ctx, "tag-team")
	require.NoError(t, err)
	assert.Equal(t, "Approve the Q4 report?", qs[id].Question, "the question is kept apart from the row and the tags (#11555)")

	e.h.applyManifestTags(ctx, "tag-team", "sess-dev", false, []board.TaskArtifact{{Name: "report.md", URI: "coral://artifacts/" + id, Tags: []string{"final", "a", "b", "c"}}})
	tags, _ = e.h.bs.ArtifactTags(ctx, "tag-team")
	assert.Len(t, tags[id], board.MaxArtifactTags, "added to what the object has, at most five in all")
	assert.Contains(t, tags[id], "for review")
}

// What an agent uploads can carry tags: the team's tags of the stored object (the uploader's board).
func TestAnUploadCarriesItsTags(t *testing.T) {
	l := newLinkRig(t)
	old := uploaderLookup
	t.Cleanup(func() { uploaderLookup = old })
	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) { return "alpha", "Backend", "Backend" }
	up := func(query, content string) (int, map[string]any) {
		req, err := http.NewRequest(http.MethodPost, l.srv.URL+"/api/agent/artifacts?session_id=s1"+query, strings.NewReader(content))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "report.md")
		req.Header.Set("X-Artifact-Media-Type", "text/markdown")
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	code, out := up("&tag=For+Review&tag=internal&tag=no+way%21&tag=For+Review&question=Approve+the+report%3F", "tagged bytes")
	require.Equal(t, http.StatusCreated, code, out)
	assert.Equal(t, []any{"for review", "internal"}, out["tags"], "normalised, once each, a word that is not a tag left out")
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	tags, err := l.h.bs.ArtifactTags(context.Background(), "alpha")
	require.NoError(t, err)
	assert.Equal(t, []string{"for review", "internal"}, tags[id])
	qs, err := l.h.bs.ArtifactQuestions(context.Background(), "alpha")
	require.NoError(t, err)
	assert.Equal(t, "Approve the report?", qs[id].Question, "the upload's question is kept")
	// For review with no question is refused before anything is stored; another tag needs none.
	code, out = up("&tag=for+review", "other bytes")
	require.Equal(t, http.StatusBadRequest, code, out)
	assert.Equal(t, "question_required", out["code"])
	code, out = up("&tag=for+review&question=%E2%80%8B", "other bytes")
	require.Equal(t, http.StatusBadRequest, code, "a question that is empty once cleaned is no question: %v", out)
	code, out = up("&tag=for+review&question="+strings.Repeat("x", 300), "long bytes")
	require.Equal(t, http.StatusCreated, code, out)
	lid := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	qs, _ = l.h.bs.ArtifactQuestions(context.Background(), "alpha")
	assert.Len(t, []rune(qs[lid].Question), board.MaxReviewQuestionRunes, "cut at 140 on the server")
	code, out = up("&tag=internal", "plain bytes")
	require.Equal(t, http.StatusCreated, code, out)

	code, out = up("", "untagged bytes")
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "tags", "no tags asked: no key")

	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) { return "", "", "" }
	code, out = up("&tag=internal", "no board bytes")
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "tags", "an agent with no board has no team to tag for")
}

// An agent's token is refused on the set-tags route; the Operator (no token) is not.
func TestAnAgentTokenIsRefusedOnTheSetTagsRoute(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	token, err := db.MintSessionToken(context.Background(), "sid-dev", "claude-dev")
	require.NoError(t, err)
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return false })
	r := chi.NewRouter()
	r.Use(o.Middleware)
	reached := 0
	r.Put("/api/board/{project}/artifacts/{id}/tags", func(w http.ResponseWriter, r *http.Request) { reached++ })
	assert.NotEmpty(t, operatorOnlyRoutes["PUT /api/board/{project}/artifacts/{id}/tags"])

	req := httptest.NewRequest(http.MethodPut, "/api/board/tag-team/artifacts/"+strings.Repeat("a", 64)+"/tags", bytes.NewBufferString(`{"tags":["internal"]}`))
	req.Header.Set(store.SessionTokenHeader, token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "forbidden_for_agent")
	assert.Zero(t, reached)

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/board/tag-team/artifacts/"+strings.Repeat("a", 64)+"/tags", bytes.NewBufferString(`{"tags":["internal"]}`)))
	assert.Equal(t, http.StatusOK, rec.Code, "a request with no agent's token reaches the handler")
	assert.Equal(t, 1, reached)
}

// A Hub viewer sees the words through the connector's redaction, as it sees the names: a tag or a goal's title that holds a secret is hidden.
func TestTagsAndGoalTitlesAreRedactedForAHubViewer(t *testing.T) {
	secret := "ghp_" + strings.Repeat("a1B2c3D4e5", 4)
	it := teamArtifact{Name: "n", GoalTitle: "Ship " + secret, Tags: []string{"internal", secret}}
	redactItemForTunnel(&it)
	assert.NotContains(t, it.GoalTitle, secret, "the goal's title")
	assert.NotContains(t, strings.Join(it.Tags, " "), secret, "a tag")
	assert.Equal(t, "internal", it.Tags[0], "an ordinary tag is left as it is")
}

// A task result that asks for review without a question gets no review tag (#11555): the Operator would not know what is asked. Its other tags still apply.
func TestManifestForReviewNeedsAQuestion(t *testing.T) {
	e := newTagEnv(t)
	ctx := context.Background()
	id := e.ids["report.md"]
	e.uploadedBy(t, "sess-dev", id)
	for _, q := range []string{"", "   ", string(rune(0x200b))} {
		e.h.applyManifestTags(ctx, "tag-team", "sess-dev", false, []board.TaskArtifact{{Name: "report.md", URI: "coral://artifacts/" + id, Tags: []string{"for review", "internal"}, Question: q}})
		tags, err := e.h.bs.ArtifactTags(ctx, "tag-team")
		require.NoError(t, err)
		assert.Equal(t, []string{"internal"}, tags[id], "no question (%q): no review tag, the other tag stays", q)
	}
	qs, _ := e.h.bs.ArtifactQuestions(ctx, "tag-team")
	assert.Empty(t, qs)
}

// uploadedBy writes the upload record that makes session the uploader of the stored object id (the record uploadRecordOf trusts only with the object and its sidecar).
func (e *tagEnv) uploadedBy(t *testing.T, session, id string) {
	t.Helper()
	dir := uploadsDir(e.coralDir, session)
	require.NotEmpty(t, dir)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "m", MediaType: "text/markdown", Size: 999999, Digest: "sha256:" + id}, CreatedAt: "2026-10-31T00:00:00Z", Board: "tag-team"})
	require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
}

// An agent cannot tag for review, with a question of its own, a file another agent uploaded (#11555, Security's SHOULD A); a person can; and the uploader's own file keeps the tag and the question.
func TestManifestForReviewKeepsOnlyTheAskersOwnUpload(t *testing.T) {
	e := newTagEnv(t)
	ctx := context.Background()
	id := e.ids["report.md"]
	e.uploadedBy(t, "sess-owner", id)
	arts := func() []board.TaskArtifact {
		return []board.TaskArtifact{{Name: "report.md", URI: "coral://artifacts/" + id, Tags: []string{"for review", "internal"}, Question: "Approve the report?"}}
	}
	e.h.applyManifestTags(ctx, "tag-team", "sess-other", false, arts())
	tags, _ := e.h.bs.ArtifactTags(ctx, "tag-team")
	assert.Equal(t, []string{"internal"}, tags[id], "another agent's upload: no review tag from a task result")
	qs, _ := e.h.bs.ArtifactQuestions(ctx, "tag-team")
	assert.Empty(t, qs, "and no question")
	e.h.applyManifestTags(ctx, "tag-team", "sess-owner", false, arts())
	tags, _ = e.h.bs.ArtifactTags(ctx, "tag-team")
	assert.Contains(t, tags[id], "for review", "the uploader's own file keeps it")
	qs, _ = e.h.bs.ArtifactQuestions(ctx, "tag-team")
	assert.Equal(t, "Approve the report?", qs[id].Question)

	other := e.ids["scratch.log"]
	e.h.applyManifestTags(ctx, "tag-team", "operator", true, []board.TaskArtifact{{Name: "scratch.log", URI: "coral://artifacts/" + other, Tags: []string{"for review"}, Question: "Look at this?"}})
	tags, _ = e.h.bs.ArtifactTags(ctx, "tag-team")
	assert.Contains(t, tags[other], "for review", "a person's result may tag any stored file")
}

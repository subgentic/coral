package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13757: the Markdown editor's save is a new version of the file's series, a compare-and-swap on the newest, the Operator's alone, stored exactly as sent.

type editEnv struct {
	srv      *httptest.Server
	h        *BoardHandler
	coralDir string
}

// newEditEnv serves the two edit routes as a person (or, with caller "", as nobody verified); "key" is the hub's API key.
func newEditEnv(t *testing.T, caller string) *editEnv {
	t.Helper()
	_, h, coralDir := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) {
		switch sessionID {
		case sessAlice:
			return "alpha", "Alice", "worker"
		case sessBob:
			return "beta", "Bob", "worker"
		}
		return "", "", ""
	}
	t.Cleanup(func() { uploaderLookup = old })
	as := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			switch caller {
			case "person":
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			case "key":
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerAPIKey))
			}
			fn(w, req)
		}
	}
	r := chi.NewRouter()
	r.Get("/api/board/{project}/artifacts/{digest}/edit", as(h.GetArtifactEdit))
	r.Post("/api/board/{project}/artifacts/{digest}/edit", as(h.SaveArtifactEdit))
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	subscribeSession(t, h, "beta", "Bob", sessBob)
	return &editEnv{srv: s, h: h, coralDir: coralDir}
}

// seed stores content as an agent's upload of session: a first version (ref ""), or a new version of ref, exactly as the upload route does.
func (e *editEnv) seed(t *testing.T, session, name, mediaType, ref, content string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(content))
	id := hex.EncodeToString(sum[:])
	dir := filepath.Join(e.coralDir, "artifacts", "objects")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	tmp := filepath.Join(dir, artifactUploadTempP+id)
	require.NoError(t, os.WriteFile(tmp, []byte(content), 0o600))
	var plan *seriesPlan
	var stamp *seriesStamp
	if ref != "" {
		board, _, _ := uploaderOf(session)
		var err error
		plan, err = planNewVersion(e.coralDir, "coral://artifacts/"+ref, board, id)
		require.NoError(t, err)
		defer plan.unlock()
		stamp = &plan.stamp
	}
	_, _, err := storeArtifactFile(e.coralDir, session, name, mediaType, tmp, id, int64(len(content)), stamp, 0)
	require.NoError(t, err)
	if plan != nil {
		_, err = plan.commit(e.coralDir, id, session)
		require.NoError(t, err)
	}
	return id
}

func (e *editEnv) save(t *testing.T, project, opened, expected, content string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	url := e.srv.URL + "/api/board/" + project + "/artifacts/" + opened + "/edit"
	if expected != "" {
		url += "?expected_latest=" + expected
	}
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(content))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "text/markdown; charset=utf-8")
	req.Header.Set("Origin", e.srv.URL)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	for k, v := range hdr {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *editEnv) objects(t *testing.T) int {
	t.Helper()
	ents, _ := os.ReadDir(filepath.Join(e.coralDir, "artifacts", "objects"))
	n := 0
	for _, f := range ents {
		if !strings.HasSuffix(f.Name(), ".json") {
			n++
		}
	}
	return n
}

func editSha(s string) string { x := sha256.Sum256([]byte(s)); return hex.EncodeToString(x[:]) }

func TestASaveIsANewVersionStoredExactlyAsSentAndOwnedByTheTeam(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "# plan\n")
	text := "\xef\xbb\xbf# plan\r\n\r\nline with a trailing space \r\n\xe2\x80\xae\xe2\x80\x8b"
	code, out := e.save(t, "alpha", v1, v1, text, nil)
	require.Equal(t, http.StatusCreated, code, out)
	v2 := editSha(text)
	assert.Equal(t, v2, out["id"])
	assert.EqualValues(t, 2, out["version"])
	assert.Equal(t, "plan.md", out["name"])
	series, _ := out["series_id"].(string)
	require.Regexp(t, `^[0-9a-f]{32}$`, series)
	data, err := os.ReadFile(filepath.Join(e.coralDir, "artifacts", "objects", v2))
	require.NoError(t, err)
	assert.Equal(t, text, string(data), "the BOM, the CRLF line ends, the trailing space and the invisible characters are stored as sent")
	old, _ := os.ReadFile(filepath.Join(e.coralDir, "artifacts", "objects", v1))
	assert.Equal(t, "# plan\n", string(old), "the opened version's bytes are untouched")

	var rec agentUploadRecord
	b, err := os.ReadFile(filepath.Join(e.coralDir, "artifacts", "uploads", sessAlice, v2+".json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(b, &rec))
	assert.Equal(t, "alpha", rec.Board, "it is the team's file")
	assert.Equal(t, board.OperatorName, rec.Uploader)
	assert.Equal(t, sourceOperatorEdit, rec.Source)
	assert.Equal(t, series, rec.SeriesID)
	assert.Equal(t, 2, rec.Version)
	assert.Equal(t, v1, rec.Previous)
	assert.Equal(t, "text/markdown", rec.MediaType)
	ms := seriesMembers(e.coralDir, series)
	require.Len(t, ms, 2)
	assert.Equal(t, v2, ms[1].Digest)
}

func TestASaveAgainstTheNewestGoesThroughAndAStaleOneIs409WithTheNewest(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	code, out := e.save(t, "alpha", v1, v1, "two", nil)
	require.Equal(t, 201, code, out)
	v2 := editSha("two")
	// the editor that still has v1 open saves against v1: the newest is v2
	before := e.objects(t)
	code, out = e.save(t, "alpha", v1, v1, "mine", nil)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "stale_version", out["code"])
	assert.Equal(t, v2, out["latest_digest"])
	assert.EqualValues(t, 2, out["latest_version"])
	assert.Equal(t, before, e.objects(t), "nothing was written")
	// the explicit Save after theirs: opened v1, but expecting what it has seen now (v2)
	code, out = e.save(t, "alpha", v1, v2, "mine", nil)
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 3, out["version"])
	// the opened version is in the URL, the expected one in the query: with no expected, the opened one is
	code, out = e.save(t, "alpha", editSha("mine"), "", "again", nil)
	assert.Equal(t, 201, code, out)
}

func TestAnAgentsNewerUploadWinsOverAnEditorThatOpenedTheOlderVersion(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	v2 := e.seed(t, sessAlice, "plan.md", "text/markdown", v1, "agent two")
	code, out := e.save(t, "alpha", v1, v1, "operator two", nil)
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, v2, out["latest_digest"], "the agent's version is the newest, not overwritten")
	assert.Equal(t, 2, len(seriesMembersOf(t, e, v1)))
}

func seriesMembersOf(t *testing.T, e *editEnv, digest string) []seriesMember {
	t.Helper()
	sid, _, in := digestSeries(e.coralDir, digest)
	require.True(t, in)
	return seriesMembers(e.coralDir, sid)
}

func TestTwoSavesAtOnceAreOneAfterTheOtherAndTheSecondIs409(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, text := range []string{"left", "right"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = e.save(t, "alpha", v1, v1, text, nil)
		}()
	}
	wg.Wait()
	assert.ElementsMatch(t, []int{http.StatusCreated, http.StatusConflict}, codes, "exactly one wins")
	assert.Len(t, seriesMembersOf(t, e, v1), 2, "the series has the first version and the winner: no fork, no lost version")
}

func TestTheSameBytesAsTheNewestAreNotAddedAgain(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	code, out := e.save(t, "alpha", v1, v1, "two", nil)
	require.Equal(t, 201, code, out)
	code, out = e.save(t, "alpha", v1, editSha("two"), "two", nil)
	assert.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, false, out["created"])
	assert.Len(t, seriesMembersOf(t, e, v1), 2)
}

func TestOnlyAPersonFromTheServersOwnPageMaySaveAndOnlyOwnTeamsMarkdown(t *testing.T) {
	person := newEditEnv(t, "person")
	v1 := person.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	other := person.seed(t, sessBob, "theirs.md", "text/markdown", "", "bob")
	txt := person.seed(t, sessAlice, "data.csv", "text/csv", "", "a,b")
	for name, c := range map[string]struct {
		project, opened, expected, content string
		hdr                                map[string]string
		want                               int
	}{
		"another site":         {"alpha", v1, v1, "x", map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}, 403},
		"no origin at all":     {"alpha", v1, v1, "x", map[string]string{"Sec-Fetch-Site": "", "Origin": ""}, 403},
		"another team's file":  {"alpha", other, other, "x", nil, 404},
		"a file nobody has":    {"alpha", editSha("none"), editSha("none"), "x", nil, 404},
		"the wrong team":       {"beta", v1, v1, "x", nil, 404},
		"not markdown":         {"alpha", txt, txt, "x", nil, 415},
		"not a digest":         {"alpha", "not-a-digest", v1, "x", nil, 400},
		"a bad expected value": {"alpha", v1, "latest", "x", nil, 400},
		"nothing":              {"alpha", v1, v1, "", nil, 400},
		"not UTF-8":            {"alpha", v1, v1, "ok \xff\xfe", nil, 400},
		"too big":              {"alpha", v1, v1, strings.Repeat("a", maxMarkdownEdit+1), nil, 413},
	} {
		code, out := person.save(t, c.project, c.opened, c.expected, c.content, c.hdr)
		assert.Equal(t, c.want, code, "%s: %v", name, out)
	}
	assert.Len(t, seriesMembersNone(person, v1), 0, "none of the refused saves wrote a version")
	exact := strings.Repeat("a", maxMarkdownEdit)
	code, out := person.save(t, "alpha", v1, v1, exact, nil)
	assert.Equal(t, 201, code, "exactly the limit is taken: %v", out)

	agent := newEditEnv(t, "")
	a1 := agent.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	code, _ = agent.save(t, "alpha", a1, a1, "x", nil)
	assert.Equal(t, 403, code, "a caller that is no person is refused")
	key := newEditEnv(t, "key")
	k1 := key.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	code, _ = key.save(t, "alpha", k1, k1, "x", nil)
	assert.Equal(t, 403, code, "the hub's key is no person: the save needs the stamp")
}

func seriesMembersNone(e *editEnv, digest string) []seriesMember {
	if sid, _, in := digestSeries(e.coralDir, digest); in {
		return seriesMembers(e.coralDir, sid)
	}
	return nil
}

func TestWhatAFileAllowsIsReadableByThePersonAndTheHubsKey(t *testing.T) {
	for _, caller := range []string{"person", "key"} {
		e := newEditEnv(t, caller)
		v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
		v2 := e.seed(t, sessAlice, "plan.md", "text/markdown", v1, "two")
		csv := e.seed(t, sessAlice, "data.csv", "text/csv", "", "a")
		get := func(project, digest string) (int, map[string]any) {
			resp, err := http.Get(e.srv.URL + "/api/board/" + project + "/artifacts/" + digest + "/edit")
			require.NoError(t, err)
			defer resp.Body.Close()
			var out map[string]any
			_ = json.NewDecoder(resp.Body).Decode(&out)
			return resp.StatusCode, out
		}
		code, out := get("alpha", v1)
		require.Equal(t, 200, code, caller)
		assert.Equal(t, true, out["can_edit"], caller)
		assert.Equal(t, v2, out["latest_digest"], "the newest version, whichever one was opened")
		assert.EqualValues(t, 2, out["version"])
		assert.Equal(t, "plan.md", out["name"])
		assert.EqualValues(t, maxMarkdownEdit, out["max_bytes"])
		code, out = get("alpha", csv)
		require.Equal(t, 200, code)
		assert.Equal(t, false, out["can_edit"])
		assert.NotEmpty(t, out["reason"])
		code, _ = get("beta", v1)
		assert.Equal(t, 404, code, "another team's file looks like no file")
	}
}

func TestAPausedBoardDoesNotStopTheOperatorsSave(t *testing.T) {
	e := newEditEnv(t, "person")
	v1 := e.seed(t, sessAlice, "plan.md", "text/markdown", "", "one")
	e.h.SetPaused("alpha", true)
	code, out := e.save(t, "alpha", v1, v1, "two", nil)
	assert.Equal(t, http.StatusCreated, code, "a save sends nothing to an agent, so a paused board does not hold it: %v", out)
}

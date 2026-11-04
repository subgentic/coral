package routes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

// #13289: file search says how many files match (total) and whether more are cut (has_more); a search pages by cursor on (score, path); a listing with no q has total and has_more and no cursor.
func TestFileSearchPagesWithATotalAndACursor(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/search-files", handler.SearchFiles)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	repo := t.TempDir()
	git := func(args ...string) {
		c := consoletest.HiddenCommand("git", append([]string{"-c", "user.email=a@b.c", "-c", "user.name=n"}, args...)...)
		c.Dir = repo
		if out, err := c.CombinedOutput(); err != nil {
			t.Skipf("git is not usable here: %v %s", err, out)
		}
	}
	git("init", "-q")
	const n = 8
	for i := 0; i < n; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repo, fmt.Sprintf("alpha-%d.txt", i)), []byte("x"), 0o644))
	}
	require.NoError(t, os.WriteFile(filepath.Join(repo, "other.md"), []byte("x"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "alpha"), []byte("x"), 0o644)) // a basename equal to the query scores first
	git("add", ".")
	git("commit", "-qm", "c")
	const sid = "00000000-0000-0000-0000-000000013289"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
	get := func(extra url.Values) (int, map[string]any) {
		extra.Set("session_id", sid)
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/search-files?" + extra.Encode())
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	code, all := get(url.Values{"q": {"alpha"}})
	require.Equal(t, http.StatusOK, code, all)
	assert.Len(t, all["files"], n+1, "no limit: every match under the setting, as before")
	assert.EqualValues(t, n+1, all["total"])
	assert.Equal(t, false, all["has_more"])
	assert.Equal(t, "alpha", all["files"].([]any)[0], "the basename match first, as before")

	seen := map[string]bool{}
	q, pages := url.Values{"q": {"alpha"}, "limit": {"4"}}, 0
	for {
		code, p := get(q)
		require.Equal(t, http.StatusOK, code, p)
		pages++
		assert.EqualValues(t, n+1, p["total"])
		for _, f := range p["files"].([]any) {
			require.False(t, seen[f.(string)], "sent once: "+f.(string))
			seen[f.(string)] = true
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, p["files"], 4)
		q = url.Values{"q": {"alpha"}, "limit": {"4"}, "cursor": {p["next_cursor"].(string)}}
		require.Less(t, pages, 6)
	}
	assert.Len(t, seen, n+1)
	assert.Equal(t, 3, pages)

	// exactly one page
	_, p := get(url.Values{"q": {"alpha"}, "limit": {fmt.Sprint(n + 1)}})
	assert.Equal(t, false, p["has_more"])
	assert.Nil(t, p["next_cursor"])

	// no q: total and has_more, no cursor
	_, p = get(url.Values{"limit": {"3"}})
	assert.Len(t, p["files"], 3)
	assert.EqualValues(t, n+2, p["total"])
	assert.Equal(t, true, p["has_more"])
	assert.Nil(t, p["next_cursor"])

	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, bad := range []url.Values{{"limit": {"0"}}, {"limit": {"x"}}, {"limit": {"100000"}}, {"q": {"a"}, "cursor": {"!!!"}}, {"q": {"a"}, "cursor": {b64(`{"s":9,"p":"x"}`)}}, {"q": {"a"}, "cursor": {b64(`{"s":0,"p":""}`)}},
		{"q": {"a"}, "cursor": {strings.Repeat("A", 1100)}}, {"cursor": {b64(`{"s":0,"p":"x"}`)}}} {
		code, _ := get(bad)
		assert.Equal(t, http.StatusBadRequest, code, bad.Encode())
	}
	padded := func(chars int) string {
		body := `{"s":0,"p":"alpha"}`
		return b64(body + strings.Repeat(" ", chars*3/4-len(body)))
	}
	code, _ = get(url.Values{"q": {"alpha"}, "cursor": {padded(1024)}})
	assert.Equal(t, http.StatusOK, code, "exactly 1,024 characters")
	code, _ = get(url.Values{"q": {"alpha"}, "cursor": {padded(1028)}})
	assert.Equal(t, http.StatusBadRequest, code, "1,028 characters")
}

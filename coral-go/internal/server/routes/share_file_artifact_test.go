package routes

import (
	"context"
	"encoding/json"
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

	"github.com/subgentic/coral/internal/store"
)

// #10269: Share as artifact on a Files row or an open diff stores that file as an artifact the person owns and answers with its link; the file is read under the bounds of the file viewer.
func TestShareFileArtifactStoresTheFileAsTheOwners(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/share-file", handler.ShareFileArtifact)
	router.Get("/api/artifacts/{id}", handler.getAgentArtifact)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	work := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(work, "out"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(work, "out", "report.md"), []byte("# Report\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(work, ".env"), []byte("TOKEN=secret\n"), 0o644))
	outside := filepath.Join(t.TempDir(), "outside.txt")
	require.NoError(t, os.WriteFile(outside, []byte("not yours"), 0o644))
	const sid = "00000000-0000-0000-0000-000000010269"
	name := "claude-" + sid
	terminal.addSession(name, work)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: work}))
	share := func(fp string) (int, map[string]any) {
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/share-file?session_id="+sid+"&filepath="+url.QueryEscape(fp), "application/json", strings.NewReader(""))
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}

	code, body := share("out/report.md")
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, "report.md", body["name"], "the artifact is named for the file")
	assert.Equal(t, float64(len("# Report\n")), body["size"])
	uri, _ := body["uri"].(string)
	assert.True(t, strings.HasPrefix(uri, "coral://artifacts/"), uri)
	url, _ := body["url"].(string)
	resp, err := http.Get(server.URL + strings.SplitN(url, "?", 2)[0])
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode, "the link opens the stored file")

	for _, fp := range []string{".env", "../outside.txt", "missing.txt", "out"} {
		code, _ := share(fp)
		assert.GreaterOrEqual(t, code, 400, "%q is not shared", fp)
	}
	code, _ = share("")
	assert.Equal(t, http.StatusBadRequest, code, "a file is named")
}

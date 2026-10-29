package routes

import (
	"context"
	"encoding/json"
	"io"
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
	"github.com/subgentic/coral/pkg/tunnel"
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

// #10269: the limits of a share. A picture goes without its metadata (as an agent's upload does), a file over the agent upload cap says it is too large to share, and the hourly bucket of
// shared files runs out with a 429.
func TestShareFileArtifactLimits(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/share-file", handler.ShareFileArtifact)
	router.Get("/api/artifacts/{id}", handler.getAgentArtifact)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	work := t.TempDir()
	photo := withJPEGExif(genJPEG(t))
	require.Contains(t, string(photo), "Exif", "the fixture carries its metadata")
	require.NoError(t, os.WriteFile(filepath.Join(work, "photo.jpg"), photo, 0o644))
	big, err := os.Create(filepath.Join(work, "big.bin"))
	require.NoError(t, err)
	require.NoError(t, big.Truncate(maxAgentArtifactSize+1)) // sparse: no 64 MiB is written
	require.NoError(t, big.Close())
	require.NoError(t, os.WriteFile(filepath.Join(work, "note.txt"), []byte("hi\n"), 0o644))
	const sid = "00000000-0000-0000-0000-000000020269"
	name := "claude-" + sid
	terminal.addSession(name, work)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: work}))
	share := func(fp string) (*http.Response, map[string]any) {
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/share-file?session_id="+sid+"&filepath="+url.QueryEscape(fp), "application/json", strings.NewReader(""))
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		return resp, body
	}

	resp, body := share("photo.jpg")
	require.Equal(t, http.StatusOK, resp.StatusCode, "%v", body)
	got, err := http.Get(server.URL + strings.SplitN(body["url"].(string), "?", 2)[0])
	require.NoError(t, err)
	stored, _ := io.ReadAll(got.Body)
	got.Body.Close()
	assert.NotContains(t, string(stored), "Exif", "the stored picture has no metadata")
	assert.Equal(t, []byte{0xFF, 0xD8}, stored[:2], "and is still a picture")
	assert.Less(t, len(stored), len(photo), "the metadata segment is gone")

	resp, body = share("big.bin")
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
	assert.Contains(t, body["error"], "too large to share", "%v", body)

	for i := 0; i < uploadWindowCount; i++ { // the picture used one of the hour's shares; the rest run out
		resp, _ = share("note.txt")
		if resp.StatusCode == http.StatusTooManyRequests {
			assert.NotEmpty(t, resp.Header.Get("Retry-After"), "a 429 says when to come back")
			return
		}
		require.Equal(t, http.StatusOK, resp.StatusCode, "share %d", i)
	}
	t.Fatalf("the hourly limit of %d shared files was never reached", uploadWindowCount)
}

// #10855 (coral-hub Security): a share through Coral Hub counts in the window of the hub account that made it, with half the allowance, so a grantee never uses up the owner's own window or another
// grantee's; and the upload record names that account instead of leaving the share looking like the owner's alone.
func TestShareFileArtifactBucketsAndRecordsByCaller(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/share-file", handler.ShareFileArtifact)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	work := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(work, "note.txt"), []byte("hi\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(work, "alices.txt"), []byte("from a grantee\n"), 0o644))
	const sid = "00000000-0000-0000-0000-000000030269"
	name := "claude-" + sid
	terminal.addSession(name, work)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: work}))
	const alice, bob = "hub-user-aaaaaaaa", "hub-user-bbbbbbbb"
	share := func(hubUser string, fp ...string) *http.Response {
		file := "note.txt"
		if len(fp) > 0 {
			file = fp[0]
		}
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/sessions/live/"+name+"/share-file?session_id="+sid+"&filepath="+file, strings.NewReader(""))
		require.NoError(t, err)
		if hubUser != "" {
			req.Header.Set(tunnel.ViaHeader, "1")
			req.Header.Set(tunnel.HubUserHeader, hubUser)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp
	}

	// the record names the account that shared the file (a file of its own, so no later share of the same bytes rewrites the record)
	require.Equal(t, http.StatusOK, share(alice, "alices.txt").StatusCode)
	matches, err := filepath.Glob(filepath.Join(handler.cfg.CoralDir(), "artifacts", "uploads", "*", "*.json"))
	require.NoError(t, err)
	var recorded []string
	for _, m := range matches {
		b, err := os.ReadFile(m)
		require.NoError(t, err)
		recorded = append(recorded, string(b))
	}
	require.NotEmpty(t, recorded, "the share left an upload record")
	assert.Contains(t, strings.Join(recorded, "\n"), alice, "the record names the grantee who shared it")

	half := uploadWindowCount / 2
	for i := 1; i < half; i++ { // alice's file above was her first
		require.Equal(t, http.StatusOK, share(alice).StatusCode, "alice's share %d is within her half allowance", i)
	}
	assert.Equal(t, http.StatusTooManyRequests, share(alice).StatusCode, "alice used up her window")
	assert.Equal(t, http.StatusOK, share(bob).StatusCode, "another grantee has a window of her own")
	assert.Equal(t, http.StatusOK, share("").StatusCode, "so has the owner on this computer: a grantee cannot use up the owner's quota")
}

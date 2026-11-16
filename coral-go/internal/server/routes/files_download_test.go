package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// Download saves any file of the agent's folder byte for byte (#17655): a zip or a PDF read as text was damaged. The same folder checks as the preview; an attachment of no runnable type; a size cap.
func TestDownloadGivesAnyFileItsExactBytes(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/file-content", handler.GetFileContent)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	dir := t.TempDir()
	zip := make([]byte, 0, 300)
	for i := 0; i < 300; i++ {
		zip = append(zip, byte(i%256)) // every byte value, so invalid UTF-8 and NULs: text reading would change it
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "build.zip"), zip, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "big.bin"), bytes.Repeat([]byte{7}, maxDownloadBytes+1), 0o644))
	const sid = "00000000-0000-0000-0000-000000017655"
	name := "claude-" + sid
	terminal.addSession(name, dir)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: dir}))
	get := func(file string) (*http.Response, []byte) {
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/file-content?download=1&session_id=" + sid + "&filepath=" + url.QueryEscape(file))
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, b
	}
	resp, body := get("build.zip")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, zip, body, "the exact bytes")
	assert.Equal(t, "application/octet-stream", resp.Header.Get("Content-Type"))
	assert.Equal(t, `attachment; filename=build.zip`, resp.Header.Get("Content-Disposition"))
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	resp, _ = get(".env")
	assert.Equal(t, http.StatusNotFound, resp.StatusCode, "a file the preview refuses is refused")
	resp, _ = get("../outside.zip")
	assert.NotEqual(t, http.StatusOK, resp.StatusCode, "nothing outside the folder")
	resp, _ = get("big.bin")
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode, "over the cap")
}

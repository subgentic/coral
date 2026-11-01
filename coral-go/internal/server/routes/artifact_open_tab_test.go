package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// The viewer's Open in new tab (#11836, the operator: it downloaded the file) links the artifact with ?open=1: a tab that shows the file for every type, where the plain link (Download) saves
// everything that is not inert media or plain data. Nothing it serves may run on the dashboard's origin: text of any declared type (HTML and SVG included) is its source as text/plain, a PDF is
// shown by the browser's viewer under a CSP that allows nothing, a binary file is a one-line note. The plain link is unchanged.
func TestArtifactOpenInNewTabIsReadableForEveryType(t *testing.T) {
	t.Parallel() // no shared state: these ran one after another (#5622)
	_, h, _, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "artifact-session", AgentName: "artifact-agent", AgentType: "codex", WorkingDir: t.TempDir()}))
	r := chi.NewRouter()
	r.Use(testIdentity(h.db))
	h.RegisterAgentArtifacts(r)
	server := httptest.NewServer(r)
	defer server.Close()

	upload := func(name, declared, body string) string {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/agent/artifacts?session_id=artifact-session", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", name)
		if declared != "" {
			req.Header.Set("X-Artifact-Media-Type", declared)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		require.Equal(t, http.StatusCreated, resp.StatusCode, string(data))
		var out struct {
			URL string `json:"url"`
		}
		require.NoError(t, json.Unmarshal(data, &out))
		return out.URL
	}

	cases := []struct {
		name, declared, body string
		wantType             string // what the new tab is served as
		wantBody             string // "" = the bytes unchanged
	}{
		{"page.html", "", "<script>parent.pwned=1</script>", "text/plain", ""},
		{"page.xhtml", "application/xhtml+xml", "<html xmlns='http://www.w3.org/1999/xhtml'><script>1</script></html>", "text/plain", ""},
		{"logo.svg", "", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "text/plain", ""},
		{"feed.xml", "text/xml", "<x/>", "text/plain", ""},
		{"app.js", "text/javascript", "alert(1)", "text/plain", ""},
		{"report.md", "text/markdown", "# hi", "text/plain", ""},
		{"table.csv", "text/csv", "a,b\n1,2\n", "text/plain", ""},
		{"innocent.png", "text/html", "<script>1</script>", "text/plain", ""},
		{"report.pdf", "application/pdf", "%PDF-1.4\n\x00\x01", "application/pdf", ""},
		{"archive.zip", "application/zip", "PK\x03\x04\x00\x00", "text/plain", "This file is binary (application/zip, 6 bytes) and has no readable view. Use Download to save it.\n"},
		{"bad-type", "not a media type", "\x00\x01", "text/plain", "This file is binary (unknown type, 2 bytes) and has no readable view. Use Download to save it.\n"},
		// inert media and plain data are already shown inline by the plain link
		{"notes.txt", "text/plain", "hello", "text/plain", ""},
		{"shot.png", "image/png", "\x89PNG\r\n", "image/png", ""},
		{"data.json", "application/json", "{}", "application/json", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			url := upload(c.name, c.declared, c.body)
			resp, err := http.Get(server.URL + url + "&open=1")
			require.NoError(t, err)
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			cd := resp.Header.Get("Content-Disposition")
			require.True(t, strings.HasPrefix(cd, "inline"), "Open in new tab shows the file, it does not download: %q", cd)
			require.Equal(t, c.wantType, strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
			want := c.wantBody
			if want == "" {
				want = c.body
			}
			require.Equal(t, want, string(data))
			require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
			require.NotEmpty(t, resp.Header.Get("Content-Security-Policy"), "never served without a policy")
			if c.wantType == "text/plain" && !strings.HasPrefix(c.name, "notes") {
				require.Contains(t, resp.Header.Get("Content-Security-Policy"), "sandbox", "text served as text is sandboxed too")
			}
			// the plain link is unchanged: it still downloads what is not inert
			plain, err := http.Get(server.URL + url)
			require.NoError(t, err)
			io.Copy(io.Discard, plain.Body)
			plain.Body.Close()
			inert := c.name == "notes.txt" || c.name == "shot.png" || c.name == "data.json"
			if inert {
				require.True(t, strings.HasPrefix(plain.Header.Get("Content-Disposition"), "inline"))
			} else {
				require.True(t, strings.HasPrefix(plain.Header.Get("Content-Disposition"), "attachment"), "Download is the only way these are saved: %q", plain.Header.Get("Content-Disposition"))
			}
		})
	}
}

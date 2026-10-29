package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Text other people read refuses a sign-in link: an artifact's name or tag, a task's note, a notification.
// No request carries the token, and the error never repeats it.
func TestCoralAgentRefusesASignInLink(t *testing.T) {
	const tok = "login_token=abc123def"
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, r.Method+" "+r.URL.String()+" "+strings.Join(r.Header.Values("X-Artifact-Name"), ",")+" "+string(b))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	file := filepath.Join(t.TempDir(), "report.txt")
	require.NoError(t, os.WriteFile(file, []byte("a report\n"), 0o600))

	for name, args := range map[string][]string{
		"artifact upload --name":  {"artifact", "upload", file, "--name", "link " + tok},
		"artifact upload --tag":   {"artifact", "upload", file, "--tag", tok},
		"task complete --message": {"task", "complete", "7", "--message", "done: " + tok},
		"notify --title":          {"notify", "--title", tok},
		"notify --message":        {"notify", "--title", "Done", "--message", "see " + tok},
	} {
		code, _, stderr := runAgent(t, srv.URL, args...)
		assert.NotEqual(t, 0, code, "%s: refused (%s)", name, stderr)
		assert.Contains(t, stderr, "that contains a sign-in link (login_token=)", name)
		assert.Contains(t, stderr, "To talk about the parameter, write it without '='.", name)
		assert.NotContains(t, stderr, "abc123", "%s: the error never repeats the token", name)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, req := range got {
		assert.NotContains(t, req, "abc123", "no request carries the token: %s", req)
	}
}

// An uploaded file's contents are only warned about: a text file of at most 1 MB that carries the parameter
// is named on stderr (never the token) and still uploaded; a binary file (by its contents) and a larger file
// are not looked at.
func TestAnArtifactsContentsAreOnlyWarnedAbout(t *testing.T) {
	var mu sync.Mutex
	uploads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/artifacts" {
			mu.Lock()
			uploads++
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"` + strings.Repeat("a", 64) + `"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, data, 0o600))
		return p
	}
	text := write("run.log", []byte("step 1 ok\nopened http://127.0.0.1:8471/?login_token=abc123def\n"))
	binary := write("dump.txt", append([]byte("login_token=abc123def"), 0, 1, 2))
	big := write("big.log", []byte("login_token=abc123def\n"+strings.Repeat("x", scanLimit)))

	_, _, stderr := runAgent(t, srv.URL, "artifact", "upload", text, "--no-task")
	assert.Contains(t, stderr, `warning: "run.log" contains a sign-in link's parameter (login_token=). It is uploaded anyway`)
	assert.NotContains(t, stderr, "abc123", "the warning never repeats the token")
	assert.NotContains(t, stderr, "opened http", "nor the line")
	for _, f := range []string{binary, big} {
		_, _, stderr := runAgent(t, srv.URL, "artifact", "upload", f, "--no-task")
		assert.NotContains(t, stderr, "warning:", "%s is not looked at", filepath.Base(f))
	}
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, 3, uploads, "every file is uploaded; the contents only warn")
}

// The reply command itself refuses a reply that carries a sign-in link, before it sends anything.
func TestTheReplyCommandRefusesASignInLink(t *testing.T) {
	var mu sync.Mutex
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, r.URL.Path+" "+string(b))
		mu.Unlock()
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	code, _, stderr := runAgent(t, srv.URL, "artifact", "reply", "coral://artifacts/"+strings.Repeat("a", 64), "5", "fixed, see http://localhost:8420/?login_token=abc123")
	assert.NotEqual(t, 0, code, stderr)
	assert.Contains(t, stderr, "refusing a reply that contains a sign-in link (login_token=)")
	assert.NotContains(t, stderr, "abc123")
	mu.Lock()
	defer mu.Unlock()
	for _, g := range got {
		assert.NotContains(t, g, "abc123", "nothing sent carries the token: %s", g)
		assert.NotContains(t, g, "/reply", "no reply is sent: %s", g)
	}
}

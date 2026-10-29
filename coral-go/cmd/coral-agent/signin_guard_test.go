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

// A reply to a comment is checked before anything is sent.
func TestACommentReplyRefusesASignInLink(t *testing.T) {
	err := refuseSignInLinkIn("a reply", "fixed, see http://localhost:8420/?login_token=abc123")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "abc123")
	assert.NoError(t, refuseSignInLinkIn("a reply", "the login_token parameter is now refused"))
}

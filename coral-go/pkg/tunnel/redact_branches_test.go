package tunnel

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/redact"
)

// #15478: a branch name that holds a token is replaced on the two branch routes a View viewer
// can read, through LocalHandler as a real hub session sees it; a plain name passes unchanged.
func TestViewBranchNamesAreRedacted(t *testing.T) {
	ghp := fake("ghp_", 36, alnum)
	hex := strings.Repeat("ab12", 8)
	wt := `{"base":"origin/main","worktrees":[{"branch":"feature/` + ghp + `"},{"branch":"fix/api_key=` + hex + `"},{"branch":"main"}],"more":0}`
	bodies := map[string]string{
		"/api/sessions/live/a/branches": wt,
		"/api/board/p/branches":         `{"teams":[` + wt + `]}`,
	}
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := bodies[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(b))
	})
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, local, func(l *LocalHandler) { l.RedactTokens = func() bool { return true } })
	for path := range bodies {
		resp := do(t, sess, "GET", path, "", strings.NewReader(""), nil)
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		require.NoError(t, err, path)
		body := string(raw)
		assert.Equal(t, 200, resp.StatusCode, path)
		assert.NotContains(t, body, ghp, path)
		assert.NotContains(t, body, hex, path)
		assert.Contains(t, body, redact.Marker, path)
		assert.Contains(t, body, `"branch":"main"`, path+": a plain name is unchanged")
	}
}

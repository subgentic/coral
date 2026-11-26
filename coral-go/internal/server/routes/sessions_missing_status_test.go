package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #21548 (RepoCloud): archive of a session that does not exist answered 200 with {"ok": false, "error": "Session not found"}. A script that reads the status took it for done. Each
// lifecycle route now answers a missing session with 404, a session that is not sleeping with 409, and still carries the same "error" and "ok" words the dashboard reads.
func TestALifecycleRouteAnswersAMissingSessionWith404(t *testing.T) {
	srv, _, _, ss, _ := archiveTestServer(t)
	ctx := context.Background()
	post := func(path string) (int, map[string]any) {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(""))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	for _, action := range []string{"archive", "unarchive", "wake"} {
		code, out := post("/api/sessions/live/demo/" + action)
		assert.Equal(t, http.StatusNotFound, code, "%s of a missing session: %v", action, out)
		assert.Equal(t, "Session not found", out["error"], action)
		assert.Equal(t, false, out["ok"], action)
	}
	// an agent that is awake cannot be woken: a conflict, not a 200
	const id = "00000000-0000-4000-8000-0000000000aa"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "A", WorkingDir: t.TempDir()}))
	code, out := post("/api/sessions/live/" + id + "/wake")
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "Session is not sleeping", out["error"])

	// the real answer is still a 200 with ok
	code, out = post("/api/sessions/live/" + id + "/archive")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["ok"])
}

func TestSleepOfAMissingSessionOrAnEmptyTeamAnswers404(t *testing.T) {
	srv, _, _, _ := setupSessionsTestServer(t)
	resp, err := http.Post(srv.URL+"/api/sessions/live/demo/sleep", "application/json", strings.NewReader(""))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

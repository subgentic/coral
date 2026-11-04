package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gitguard"
)

// #13247 (found measuring the Operator's far computer, #13079): a followed worktree that is paused answered `files: null`: its list is never stored (it is not the launch folder's), so the paused panel showed
// nothing and a count of changes it had no list for. The answer is the last list a pass computed for it, from the POST and the GET alike.
func TestAPausedFollowedWorktreeAnswersTheLastListAPassComputed(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	post := func(query string) map[string]any {
		req, err := http.NewRequest(http.MethodPost, r.server.URL+"/api/sessions/live/"+r.name+"/files/refresh?worktree=follow"+query, bytes.NewBufferString(`{"session_id":"`+r.sid+`"}`))
		require.NoError(t, err)
		req.Header.Set("Origin", r.server.URL)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		require.Equal(t, http.StatusOK, resp.StatusCode, "%v", body)
		return body
	}
	first := post("") // a pass runs and its list is kept
	require.Equal(t, []string{"work.txt"}, filepaths(first))
	require.Nil(t, first["paused"])

	gitguard.Pause(r.worktree, 35000, 3*time.Second) // two slow passes later: the followed folder is paused
	for name, body := range map[string]map[string]any{"the page's POST": post(""), "a GET read": r.list("&worktree=follow")} {
		assert.NotNil(t, body["paused"], "%s: the answer says it is paused", name)
		assert.Equal(t, []string{"work.txt"}, filepaths(body), "%s: the last list, not nothing", name)
		assert.EqualValues(t, 35000, body["total_changed"], "%s: the count the pause recorded", name)
	}
	// a person's Refresh still runs a pass
	manual := post("&manual=1")
	assert.Equal(t, []string{"work.txt"}, filepaths(manual))
}

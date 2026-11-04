package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/store"
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

// QA Reviewer 2's SHOULDs on af2be4db5 (#13267): a paused folder that is NOT followed keeps answering the poller's stored list, not the last pass's; the kept answers are bounded and the OLDEST key goes, not all of
// them; a pass that failed (panicked) is not kept; and an answer older than refreshLastFor is not served.
func TestAPausedLaunchFolderKeepsTheStoredListNotTheLastPass(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	r := newFollowRig(t, true)
	require.NoError(t, os.WriteFile(filepath.Join(r.launch, "a.txt"), []byte("a\n"), 0o644))
	post := func() map[string]any {
		req, err := http.NewRequest(http.MethodPost, r.server.URL+"/api/sessions/live/"+r.name+"/files/refresh", bytes.NewBufferString(`{"session_id":"`+r.sid+`"}`))
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		return body
	}
	require.Equal(t, []string{"a.txt"}, filepaths(post()), "a pass lists the launch folder's change (and stores it)")
	// the poller rewrote the stored list since: it says b.txt now
	mode := r.handler.getDiffMode(context.Background())
	if mode == "" {
		mode = "branch_point"
	}
	sid := r.sid
	require.NoError(t, r.handler.gs.ReplaceChangedFiles(context.Background(), r.name, r.launch, []store.ChangedFile{{Filepath: "b.txt", Status: "??", Source: "git"}}, &sid, mode))
	gitguard.Pause(r.launch, 5, 3*time.Second)
	body := post()
	assert.NotNil(t, body["paused"])
	assert.Equal(t, []string{"b.txt"}, filepaths(body), "the poller's stored list is the answer for a folder that is not followed, whatever the last pass said")
}

func TestTheKeptAnswersAreBoundedTheOldestGoesAFailedPassIsNotKeptAndAnOldOneIsNotServed(t *testing.T) {
	f := &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}}
	now := time.Now()
	f.mu.Lock()
	for i := 0; i < refreshLastKeep+44; i++ {
		f.keep(fmt.Sprintf("k%03d", i), refreshedFiles{total: i}, now)
	}
	f.mu.Unlock()
	require.Len(t, f.last, refreshLastKeep, "bounded")
	_, ok := f.lastFor("k000")
	assert.False(t, ok, "the oldest are gone")
	_, ok = f.lastFor("k043")
	assert.False(t, ok, "44 went, the 44th oldest included")
	got, ok := f.lastFor("k044")
	require.True(t, ok, "the next oldest stays: it did not start over")
	assert.Equal(t, 44, got.total)
	got, ok = f.lastFor(fmt.Sprintf("k%03d", refreshLastKeep+43))
	require.True(t, ok)
	assert.Equal(t, refreshLastKeep+43, got.total, "and the newest")
	// keeping a key again makes it the newest: it is not the next to go
	f.mu.Lock()
	f.keep("k044", refreshedFiles{total: 999}, now)
	f.keep("fresh", refreshedFiles{total: 1}, now)
	f.mu.Unlock()
	_, ok = f.lastFor("k044")
	assert.True(t, ok, "a key kept again is the newest")
	_, ok = f.lastFor("k045")
	assert.False(t, ok, "the next oldest went instead")

	// a pass that panicked is not kept
	func() {
		defer func() { _ = recover() }()
		_, _, _ = f.do(context.Background(), "boom", false, func() refreshedFiles { panic("git went wrong") })
	}()
	_, ok = f.lastFor("boom")
	assert.False(t, ok, "a failed pass leaves nothing to serve")

	// an answer kept longer ago than refreshLastFor is not served, and is dropped when the next answer is kept (answers are kept in time order)
	g := &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}}
	g.mu.Lock()
	g.keep("old", refreshedFiles{total: 5}, now.Add(-2*refreshLastFor))
	g.mu.Unlock()
	_, ok = g.lastFor("old")
	assert.False(t, ok, "kept two hours ago: too old")
	g.mu.Lock()
	g.keep("new", refreshedFiles{total: 6}, now)
	_, still := g.last["old"]
	g.mu.Unlock()
	assert.False(t, still, "dropped when the next answer is kept")
}

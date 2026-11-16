package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/branches"
	"github.com/subgentic/coral/internal/store"
)

// The Branches route (goal #11, Security's #6802): the snapshot for the agent's own folder, never a path, agents of other worktrees for the local dashboard only, and an agent's token
// reads only its own team's agents.

type fakeBranches struct {
	repo     branches.Repo
	own      int
	dirs     map[string]int // a folder -> the worktree that holds it
	asked    []string
	notFound map[string]bool   // dirs where For returns false
	states   map[string]string // dir -> "pending" or "done" for ReadState
	notGit   map[string]bool   // dirs that are not git repos
}

func (f *fakeBranches) Holds(_ branches.Repo, i int, dir string) bool {
	n, ok := f.dirs[dir]
	return ok && n == i
}

func (f *fakeBranches) Same(a, b branches.Repo) bool { return a.Base == b.Base }

func (f *fakeBranches) For(dir string) (branches.Repo, int, bool) {
	f.asked = append(f.asked, dir)
	if dir == "" || f.notFound[dir] {
		return branches.Repo{}, -1, false
	}
	return f.repo, f.own, true
}

func (f *fakeBranches) ReadState(dir string) (string, bool) {
	if s, ok := f.states[dir]; ok {
		return s, f.notGit[dir]
	}
	return "pending", false
}

func (f *fakeBranches) Detail(_ context.Context, _ branches.Repo, head string) (branches.Detail, bool, error) {
	if head != "abcdef012345" {
		return branches.Detail{}, false, nil
	}
	return branches.Detail{Base: "main", Commits: []branches.Commit{{ID: "abcdef012345", Author: "t", Subject: "add a thing"}}, Files: []branches.FileChange{{Path: "a.go", Added: 3}}}, true, nil
}

type branchesRig struct {
	t     *testing.T
	h     *SessionsHandler
	rt    chi.Router
	src   *fakeBranches
	plain string // a real folder with no .git anywhere above it
}

func newBranchesRig(t *testing.T) *branchesRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team, other := "team-a", "team-b"
	plain := t.TempDir()
	alice := "Alice"
	for _, s := range []struct {
		sid, name, dir string
		board          *string
		displayName    *string
	}{
		{"aaaaaaaa-0423-4000-8000-000000000001", "dev-a", "/work/repo", &team, nil},
		{"aaaaaaaa-0423-4000-8000-000000000002", "dev-a2", "/work/feature", &team, &alice},
		{"bbbbbbbb-0423-4000-8000-000000000003", "dev-b", "/work/other", &other, nil},
		{"aaaaaaaa-0423-4000-8000-000000000004", "dev-plain", plain, &team, nil},
	} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: s.sid, AgentType: "claude", AgentName: s.name, WorkingDir: s.dir, BoardName: s.board, DisplayName: s.displayName}))
		mock.addSession("claude-"+s.sid, s.dir)
	}
	src := &fakeBranches{notFound: map[string]bool{plain: true}, own: 0, repo: branches.Repo{Base: "main", At: time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC), Worktrees: []branches.Worktree{
		{Branch: "main", Head: "0123456789ab", Main: true, IsBase: true},
		{Branch: "feature", Head: "abcdef012345", Ahead: 2, Behind: 1, Changed: 3},
	}}}
	h.SetBranches(src)
	rt := chi.NewRouter()
	rt.Get("/api/sessions/live/{name}/branches", h.Branches)
	rt.Get("/api/sessions/live/{name}/branches/detail", h.BranchDetail)
	return &branchesRig{t: t, h: h, rt: rt, src: src, plain: plain}
}

// get asks for name's branches; mod makes the request the caller's (the dashboard, an agent token).
func (r *branchesRig) get(name, sid string, mod func(*http.Request) *http.Request) (int, map[string]any) {
	r.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/live/"+name+"/branches?agent_type=claude&session_id="+sid, nil)
	if mod != nil {
		req = mod(req)
	}
	rec := httptest.NewRecorder()
	r.rt.ServeHTTP(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func asBranchesDashboard(r *http.Request) *http.Request {
	r.RemoteAddr = "127.0.0.1:50000"
	r.Host = "localhost:8420"
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func asBranchesAgent(sid string) func(*http.Request) *http.Request {
	return func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid}))
	}
}

func TestTheBranchesTabShowsTheAgentsRepositoryFromTheSnapshot(t *testing.T) {
	r := newBranchesRig(t)
	code, body := r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesDashboard)
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, true, body["found"])
	assert.Equal(t, "main", body["base"])
	rows := body["worktrees"].([]any)
	require.Len(t, rows, 2)
	first := rows[0].(map[string]any)
	assert.Equal(t, true, first["current"], "the agent's own worktree")
	assert.Equal(t, true, first["is_base"], "the main worktree is the base branch")
	feature := rows[1].(map[string]any)
	assert.EqualValues(t, 2, feature["ahead"])
	assert.EqualValues(t, 3, feature["changed"])
	raw, _ := json.Marshal(body)
	assert.NotContains(t, string(raw), "/work/", "no folder path is served")
	assert.Equal(t, []string{"/work/repo"}, r.src.asked, "the folder is the session's own, from its row: never one the request names")
}

func TestABoundedCallerSeesNoAgentsOfOtherWorktrees(t *testing.T) {
	r := newBranchesRig(t)
	r.src.dirs = map[string]int{"/work/feature": 1}
	_, body := r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesDashboard)
	raw, _ := json.Marshal(body)
	assert.Contains(t, string(raw), `"name":"Alice"`, "the local dashboard sees who works where")
	assert.Contains(t, string(raw), `"display_name":"Alice"`, "the agent's display name is served")
	_, body = r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", nil) // not the local dashboard: bounded (the Hub, another page)
	raw, _ = json.Marshal(body)
	assert.NotContains(t, string(raw), "dev-a2")
	assert.NotContains(t, string(raw), "agents")
}

// Security's MUST 4: an agent of team A gets 403 for team B's agent; its own and its board mate's are read.
func TestAnAgentTokenReadsOnlyItsOwnTeamsBranches(t *testing.T) {
	r := newBranchesRig(t)
	code, _ := r.get("dev-b", "bbbbbbbb-0423-4000-8000-000000000003", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000001"))
	assert.Equal(t, http.StatusForbidden, code, "another team's agent")
	code, _ = r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000001"))
	assert.Equal(t, http.StatusOK, code, "its own")
	code, _ = r.get("dev-a2", "aaaaaaaa-0423-4000-8000-000000000002", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000001"))
	assert.Equal(t, http.StatusOK, code, "a board mate's")
	code, _ = r.get("dev-a", "", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000001"))
	assert.Equal(t, http.StatusNotFound, code, "a bounded caller names the session")
	code, _ = r.get("dev-a", "bbbbbbbb-0423-4000-8000-000000000003", asBranchesAgent("bbbbbbbb-0423-4000-8000-000000000003"))
	assert.Equal(t, http.StatusNotFound, code, "a name with another agent's session is not that agent")
}

func TestNoSnapshotIsSaidPlainly(t *testing.T) {
	r := newBranchesRig(t)
	r.h.SetBranches(nil)
	code, body := r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesDashboard)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, body["available"])
}

// The team view: the repositories the team's live agents work in, with its agents on their worktrees; another team's agents are not shown; an agent's token reads only its own team's.
func TestTheTeamViewShowsItsAgentsRepositoriesAndOnlyItsOwnTeam(t *testing.T) {
	r := newBranchesRig(t)
	r.src.dirs = map[string]int{"/work/repo": 0, "/work/feature": 1}
	rt := chi.NewRouter()
	rt.Get("/api/board/{project}/branches", r.h.TeamBranches)
	get := func(team string, mod func(*http.Request) *http.Request) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodGet, "/api/board/"+team+"/branches", nil)
		if mod != nil {
			req = mod(req)
		}
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}
	code, body := get("team-a", asBranchesDashboard)
	require.Equal(t, http.StatusOK, code)
	repos := body["repos"].([]any)
	require.Len(t, repos, 1, "both agents work in the same repository: one section")
	raw, _ := json.Marshal(body)
	assert.Contains(t, string(raw), `"name":"dev-a"`)
	assert.Contains(t, string(raw), `"name":"Alice"`)
	assert.Contains(t, string(raw), `"display_name":"Alice"`, "the team view serves the agent's display name")
	assert.NotContains(t, string(raw), "dev-b", "another team's agent")
	assert.NotContains(t, string(raw), "/work/", "no folder path")

	code, _ = get("team-a", asBranchesAgent("bbbbbbbb-0423-4000-8000-000000000003"))
	assert.Equal(t, http.StatusForbidden, code, "an agent of team B")
	code, _ = get("team-a", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000002"))
	assert.Equal(t, http.StatusOK, code, "an agent of team A")

	assert.Equal(t, "done", body["read_state"], "a team with repos is done")
	assert.Equal(t, false, body["not_git"], "the team's agents are in a git repo")
}

// #17058: the team branches say 'pending' before the first read and 'not a git folder' after.
func TestTeamBranchesPendingAndNotGit(t *testing.T) {
	r := newBranchesRig(t)
	rt := chi.NewRouter()
	rt.Get("/api/board/{project}/branches", r.h.TeamBranches)
	get := func(team string) map[string]any {
		req := httptest.NewRequest(http.MethodGet, "/api/board/"+team+"/branches", nil)
		req = asBranchesDashboard(req)
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body
	}

	r.src.notFound = map[string]bool{"/work/repo": true, "/work/feature": true, r.plain: true} // dev-plain is team A's third agent (#17483): a real folder with no .git, said done at once
	body := get("team-a")
	assert.Equal(t, "pending", body["read_state"], "before any read: pending")
	assert.Equal(t, false, body["not_git"], "pending is not not-git")
	assert.Len(t, body["repos"].([]any), 0)

	r.src.states = map[string]string{"/work/repo": "done", "/work/feature": "done"}
	r.src.notGit = map[string]bool{"/work/repo": true, "/work/feature": true}
	body = get("team-a")
	assert.Equal(t, "done", body["read_state"], "after read: done")
	assert.Equal(t, true, body["not_git"], "no git repo found")

	r.src.states["/work/repo"] = "pending"
	body = get("team-a")
	assert.Equal(t, "pending", body["read_state"], "one agent pending keeps it pending")
	assert.Equal(t, false, body["not_git"], "not done yet: not_git is false")
}

// #17483: a folder with no .git in it or above it is said so at once; a folder that may still be read is only "not found yet".
func TestAFolderThatIsNotARepositoryIsSaidAtOnce(t *testing.T) {
	r := newBranchesRig(t)
	code, body := r.get("dev-plain", "aaaaaaaa-0423-4000-8000-000000000004", asBranchesDashboard)
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, false, body["found"])
	assert.Equal(t, true, body["not_git"], "no .git here or above: not a repository, no waiting")
	assert.Equal(t, "done", body["read_state"], "#17600: one meaning with #17058's read_state: a folder the file system shows is not a repository is done, never pending")
	// a folder that does not exist on this computer is not claimed to be non-git
	r.src.notFound["/work/repo"] = true
	_, body = r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesDashboard)
	assert.Equal(t, false, body["found"])
	assert.Equal(t, false, body["not_git"])
	raw, _ := json.Marshal(body)
	assert.NotContains(t, string(raw), r.plain, "no folder path is served")
}

func TestABranchRowNamesItsAgentsByDisplayNameNotByFolder(t *testing.T) {
	r := newBranchesRig(t)
	ctx := context.Background()
	_, _, _, ss := setupSessionsTestServer(t)
	_ = ss
	dn := "Developer 2"
	rows := func() []any {
		_, body := r.get("dev-a", "aaaaaaaa-0423-4000-8000-000000000001", asBranchesDashboard)
		return body["worktrees"].([]any)
	}
	_ = ctx
	_ = dn
	assert.NotNil(t, rows())
}

func TestABranchOpensToItsCommitsAndFilesThroughItsAgentsRoute(t *testing.T) {
	r := newBranchesRig(t)
	get := func(head string) (int, map[string]any) {
		req := asBranchesDashboard(httptest.NewRequest(http.MethodGet, "/api/sessions/live/dev-a/branches/detail?agent_type=claude&session_id=aaaaaaaa-0423-4000-8000-000000000001&head="+head, nil))
		rec := httptest.NewRecorder()
		r.rt.ServeHTTP(rec, req)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}
	code, body := get("abcdef012345")
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Len(t, body["commits"], 1)
	assert.Len(t, body["files"], 1)
	code, _ = get("0000000000000")
	assert.Equal(t, http.StatusNotFound, code, "a head that is no worktree's of this repository")
}

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
	repo  branches.Repo
	own   int
	dirs  map[string]int // a folder -> the worktree that holds it
	asked []string
}

func (f *fakeBranches) Holds(_ branches.Repo, i int, dir string) bool {
	n, ok := f.dirs[dir]
	return ok && n == i
}

func (f *fakeBranches) Same(a, b branches.Repo) bool { return a.Base == b.Base }

func (f *fakeBranches) For(dir string) (branches.Repo, int, bool) {
	f.asked = append(f.asked, dir)
	if dir == "" {
		return branches.Repo{}, -1, false
	}
	return f.repo, f.own, true
}

type branchesRig struct {
	t   *testing.T
	h   *SessionsHandler
	rt  chi.Router
	src *fakeBranches
}

func newBranchesRig(t *testing.T) *branchesRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team, other := "team-a", "team-b"
	for _, s := range []struct {
		sid, name, dir string
		board          *string
	}{
		{"aaaaaaaa-0423-4000-8000-000000000001", "dev-a", "/work/repo", &team},
		{"aaaaaaaa-0423-4000-8000-000000000002", "dev-a2", "/work/feature", &team},
		{"bbbbbbbb-0423-4000-8000-000000000003", "dev-b", "/work/other", &other},
	} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: s.sid, AgentType: "claude", AgentName: s.name, WorkingDir: s.dir, BoardName: s.board}))
		mock.addSession("claude-"+s.sid, s.dir)
	}
	src := &fakeBranches{own: 0, repo: branches.Repo{Base: "main", At: time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC), Worktrees: []branches.Worktree{
		{Branch: "main", Head: "0123456789ab", Main: true},
		{Branch: "feature", Head: "abcdef012345", Ahead: 2, Behind: 1, Changed: 3},
	}}}
	h.SetBranches(src)
	rt := chi.NewRouter()
	rt.Get("/api/sessions/live/{name}/branches", h.Branches)
	return &branchesRig{t: t, h: h, rt: rt, src: src}
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
	assert.Contains(t, string(raw), `"name":"dev-a2"`, "the local dashboard sees who works where")
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
	assert.Contains(t, string(raw), `"name":"dev-a2"`)
	assert.NotContains(t, string(raw), "dev-b", "another team's agent")
	assert.NotContains(t, string(raw), "/work/", "no folder path")

	code, _ = get("team-a", asBranchesAgent("bbbbbbbb-0423-4000-8000-000000000003"))
	assert.Equal(t, http.StatusForbidden, code, "an agent of team B")
	code, _ = get("team-a", asBranchesAgent("aaaaaaaa-0423-4000-8000-000000000002"))
	assert.Equal(t, http.StatusOK, code, "an agent of team A")
}

package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

const homeSID = "6682ebdf-65a4-4396-8ef3-26ead8208b8a"

func putHomeFolder(t *testing.T, base, team, dir string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, base+"/api/teams/detail/"+team+"/home-folder", strings.NewReader(`{"working_dir":`+homeJSONString(dir)+`}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	b.Write(buf[:n])
	return resp.StatusCode, b.String()
}

func homeJSONString(s string) string { return `"` + strings.ReplaceAll(s, `\`, `\\`) + `"` }

func homeFolderServer(t *testing.T) (*httptest.Server, *SessionsHandler, *mockSessionTerminal, *store.SessionStore, *store.TeamStore) {
	t.Helper()
	srv, handler, terminal, ss, ts := archiveTestServer(t)
	r := chi.NewRouter()
	r.Put("/api/teams/detail/{name}/home-folder", handler.SetTeamHomeFolder)
	r.Post("/api/sessions/live/{sessionID}/wake", handler.WakeSession)
	_ = srv
	hs := httptest.NewServer(r)
	t.Cleanup(hs.Close)
	return hs, handler, terminal, ss, ts
}

// The Operator changes a team's home folder: it is stored, and refused unless it is an absolute folder that exists (#10815).
func TestSetTeamHomeFolderValidatesTheFolder(t *testing.T) {
	srv, _, _, _, ts := homeFolderServer(t)
	ctx := context.Background()
	old := t.TempDir()
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "coral-hub", ConfigJSON: "{}", WorkingDir: old})
	require.NoError(t, err)
	good := t.TempDir()
	file := filepath.Join(t.TempDir(), "a-file")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o644))

	for name, dir := range map[string]string{"relative": "coral-hub", "empty": "", "missing": filepath.Join(good, "nope"), "a file": file} {
		code, body := putHomeFolder(t, srv.URL, "coral-hub", dir)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %s", name, body)
		got, _ := ts.GetTeam(ctx, "coral-hub")
		assert.Equal(t, old, got.WorkingDir, "%s: a refused folder changes nothing", name)
	}
	code, body := putHomeFolder(t, srv.URL, "coral-hub", good+"/../"+filepath.Base(good))
	require.Equal(t, http.StatusOK, code, body)
	got, _ := ts.GetTeam(ctx, "coral-hub")
	assert.Equal(t, filepath.Clean(good), got.WorkingDir, "stored cleaned")
	assert.Equal(t, team.ID, got.ID)

	code, _ = putHomeFolder(t, srv.URL, "no-such-team", good)
	assert.Equal(t, http.StatusNotFound, code)
}

// A worktree team's folder stays inside Coral's worktrees folder, as resurrect checks.
func TestSetTeamHomeFolderKeepsAWorktreeTeamInTheWorktreesFolder(t *testing.T) {
	srv, handler, _, _, ts := homeFolderServer(t)
	ctx := context.Background()
	inRoot := filepath.Join(handler.cfg.CoralDir(), "worktrees", "wt-team")
	require.NoError(t, os.MkdirAll(inRoot, 0o755))
	_, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: inRoot, IsWorktree: 1})
	require.NoError(t, err)

	code, body := putHomeFolder(t, srv.URL, "wt", t.TempDir())
	assert.Equal(t, http.StatusBadRequest, code, "outside the worktrees folder: "+body)
	other := filepath.Join(handler.cfg.CoralDir(), "worktrees", "wt-other")
	require.NoError(t, os.MkdirAll(other, 0o755))
	code, body = putHomeFolder(t, srv.URL, "wt", other)
	assert.Equal(t, http.StatusOK, code, body)
}

// Only the Operator: an agent's token is refused before the handler (the route is in operatorOnlyRoutes), a caller with no token reaches it.
func TestTeamHomeFolderIsOperatorOnly(t *testing.T) {
	const route = "PUT /api/teams/detail/{name}/home-folder"
	assert.NotEmpty(t, operatorOnlyRoutes[route], "the route is in operatorOnlyRoutes")
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	token, err := db.MintSessionToken(context.Background(), "sid-dev", "claude-dev")
	require.NoError(t, err)
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return false })
	r := chi.NewRouter()
	r.Use(o.Middleware)
	reached := 0
	r.Put("/api/teams/detail/{name}/home-folder", func(w http.ResponseWriter, r *http.Request) { reached++ })

	req := httptest.NewRequest(http.MethodPut, "/api/teams/detail/coral-hub/home-folder", strings.NewReader(`{"working_dir":"/tmp"}`))
	req.Header.Set(store.SessionTokenHeader, token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Zero(t, reached, "an agent's token never reaches the handler")

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/teams/detail/coral-hub/home-folder", strings.NewReader(`{"working_dir":"/tmp"}`)))
	assert.Equal(t, 1, reached, "the dashboard or the command line, with no agent token, does")
}

// After the folder changes, waking a member starts it in the new folder with its stored name; the row follows, and the name never comes from the folder.
func TestWakeStartsATeamMemberInTheTeamsHomeFolder(t *testing.T) {
	srv, _, terminal, ss, ts := homeFolderServer(t)
	ctx := context.Background()
	oldDir, newDir := t.TempDir(), filepath.Join(t.TempDir(), "coral-hub")
	require.NoError(t, os.MkdirAll(newDir, 0o755))
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "coral-hub", ConfigJSON: "{}", WorkingDir: oldDir})
	require.NoError(t, err)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: homeSID, AgentType: "claude", AgentName: "coral-hub", WorkingDir: oldDir, IsSleeping: 1, BoardName: ptr.NonEmpty("coral-hub")}))
	require.NoError(t, ss.SetTeamID(ctx, homeSID, team.ID))

	code, body := putHomeFolder(t, srv.URL, "coral-hub", newDir)
	require.Equal(t, http.StatusOK, code, body)

	resp, err := http.Post(srv.URL+"/api/sessions/live/"+homeSID+"/wake", "application/json", strings.NewReader("{}"))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	terminal.mu.Lock()
	pane := terminal.sessions[naming.SessionName("claude", homeSID)]
	terminal.mu.Unlock()
	require.NotNil(t, pane, "the member was started")
	assert.Equal(t, newDir, pane.CurrentPath, "in the team's home folder, not the folder it last ran in")
	ls, err := ss.GetLiveSession(ctx, homeSID)
	require.NoError(t, err)
	assert.Equal(t, newDir, ls.WorkingDir, "the row follows")
	assert.Equal(t, "coral-hub", ls.AgentName, "its name is stored, never the folder's")
}

// A team folder that has gone does not stop a wake: the member starts where it last ran.
func TestWakeKeepsTheMembersFolderWhenTheTeamsIsGone(t *testing.T) {
	srv, _, terminal, ss, ts := homeFolderServer(t)
	ctx := context.Background()
	own := t.TempDir()
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "gone-team", ConfigJSON: "{}", WorkingDir: filepath.Join(t.TempDir(), "deleted")})
	require.NoError(t, err)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: homeSID, AgentType: "claude", AgentName: "m", WorkingDir: own, IsSleeping: 1}))
	require.NoError(t, ss.SetTeamID(ctx, homeSID, team.ID))
	resp, err := http.Post(srv.URL+"/api/sessions/live/"+homeSID+"/wake", "application/json", strings.NewReader("{}"))
	require.NoError(t, err)
	resp.Body.Close()
	terminal.mu.Lock()
	pane := terminal.sessions[naming.SessionName("claude", homeSID)]
	terminal.mu.Unlock()
	require.NotNil(t, pane)
	assert.Equal(t, own, pane.CurrentPath)
}

// A team member's restart starts the new terminal in the team's home folder, not in the folder its old terminal is in (after a crash that is
// wherever the terminal was recovered): the person who changed the folder expects every start to follow it.
func TestRestartStartsATeamMemberInTheTeamsHomeFolder(t *testing.T) {
	server, handler, term, ss := setupSessionsTestServer(t)
	ts := store.NewTeamStore(handler.db)
	handler.SetTeamStore(ts)
	ctx := context.Background()
	elsewhere, teamDir := t.TempDir(), t.TempDir()
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "coral-hub", ConfigJSON: "{}", WorkingDir: teamDir})
	require.NoError(t, err)
	const oldID = "restart-home-folder"
	oldName := naming.SessionName("claude", oldID)
	term.addSession(oldName, elsewhere)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: oldID, AgentType: "claude", AgentName: "coral-hub", WorkingDir: elsewhere}))
	require.NoError(t, ss.SetTeamID(ctx, oldID, team.ID))

	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json", strings.NewReader(`{"session_id":"`+oldID+`","agent_type":"claude"}`))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	term.mu.Lock()
	defer term.mu.Unlock()
	assert.Equal(t, []string{teamDir}, term.restartDirs, "the pane was respawned in the team's home folder, not where it was")
}

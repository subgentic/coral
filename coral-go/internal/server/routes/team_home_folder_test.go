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

// homeReal is dir with its links resolved: a temp folder is itself behind a link on macOS, and the folder a team stores is the resolved one.
func homeReal(t *testing.T, dir string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(dir)
	require.NoError(t, err)
	return real
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
	assert.Equal(t, homeReal(t, good), got.WorkingDir, "stored cleaned, with its links resolved")
	assert.Equal(t, team.ID, got.ID)

	code, _ = putHomeFolder(t, srv.URL, "no-such-team", good)
	assert.Equal(t, http.StatusNotFound, code)
}

// A worktree team's folder is its own worktree and nothing else: another team's or a job run's worktree in the same folder would be removed with this team (#10860).
func TestSetTeamHomeFolderKeepsAWorktreeTeamInItsOwnWorktree(t *testing.T) {
	srv, handler, _, _, ts := homeFolderServer(t)
	ctx := context.Background()
	root := filepath.Join(handler.cfg.CoralDir(), "worktrees")
	own, another := filepath.Join(root, "wt"), filepath.Join(root, "other-team")
	for _, d := range []string{own, another} {
		require.NoError(t, os.MkdirAll(d, 0o755))
	}
	_, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: own, IsWorktree: 1})
	require.NoError(t, err)

	code, body := putHomeFolder(t, srv.URL, "wt", t.TempDir())
	assert.Equal(t, http.StatusBadRequest, code, "outside the worktrees folder: "+body)
	code, body = putHomeFolder(t, srv.URL, "wt", another)
	assert.Equal(t, http.StatusBadRequest, code, "another team's worktree in the same folder: "+body)
	got, _ := ts.GetTeam(ctx, "wt")
	assert.Equal(t, own, got.WorkingDir, "a refused folder changes nothing")
	code, body = putHomeFolder(t, srv.URL, "wt", own)
	assert.Equal(t, http.StatusOK, code, "its own worktree: "+body)
}

// Links are resolved before the checks: a link in the worktrees folder that points elsewhere is not the team's worktree, and a link to a folder is stored as the folder it is (#10860).
func TestSetTeamHomeFolderResolvesLinks(t *testing.T) {
	srv, handler, _, _, ts := homeFolderServer(t)
	ctx := context.Background()
	root := filepath.Join(handler.cfg.CoralDir(), "worktrees")
	require.NoError(t, os.MkdirAll(root, 0o755))
	elsewhere := t.TempDir()
	require.NoError(t, os.Symlink(elsewhere, filepath.Join(root, "wt"))) // the team's own name, but a link out
	_, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: filepath.Join(root, "wt"), IsWorktree: 1})
	require.NoError(t, err)
	code, body := putHomeFolder(t, srv.URL, "wt", filepath.Join(root, "wt"))
	assert.Equal(t, http.StatusBadRequest, code, "a link out of the worktrees folder is not its own worktree: "+body)

	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "link-to-folder")
	require.NoError(t, os.Symlink(target, link))
	_, err = ts.CreateTeam(ctx, &store.Team{Name: "plain", ConfigJSON: "{}", WorkingDir: t.TempDir()})
	require.NoError(t, err)
	code, body = putHomeFolder(t, srv.URL, "plain", link)
	require.Equal(t, http.StatusOK, code, body)
	got, _ := ts.GetTeam(ctx, "plain")
	assert.Equal(t, homeReal(t, target), got.WorkingDir, "stored as the folder the link points at")
	assert.NotEqual(t, link, got.WorkingDir)

	dangling := filepath.Join(t.TempDir(), "dangling")
	require.NoError(t, os.Symlink(filepath.Join(t.TempDir(), "gone"), dangling))
	code, _ = putHomeFolder(t, srv.URL, "plain", dangling)
	assert.Equal(t, http.StatusBadRequest, code, "a link to nothing is not a folder")
}

// At wake the folder is resolved again: a worktree team's folder swapped for a link elsewhere is not followed, the member keeps its own folder; and a folder stored by a plain path that has since
// become a link starts the member where the link really goes, not where the stored text says.
func TestWakeResolvesTheTeamsFolderAgain(t *testing.T) {
	srv, handler, terminal, ss, ts := homeFolderServer(t)
	ctx := context.Background()
	root := filepath.Join(handler.cfg.CoralDir(), "worktrees")
	require.NoError(t, os.MkdirAll(root, 0o755))
	own := t.TempDir()
	elsewhere := t.TempDir()
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: filepath.Join(root, "wt"), IsWorktree: 1})
	require.NoError(t, err)
	require.NoError(t, os.Symlink(elsewhere, filepath.Join(root, "wt"))) // the worktree was swapped for a link out
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: homeSID, AgentType: "claude", AgentName: "m", WorkingDir: own, IsSleeping: 1}))
	require.NoError(t, ss.SetTeamID(ctx, homeSID, team.ID))
	resp, err := http.Post(srv.URL+"/api/sessions/live/"+homeSID+"/wake", "application/json", strings.NewReader("{}"))
	require.NoError(t, err)
	resp.Body.Close()
	terminal.mu.Lock()
	pane := terminal.sessions[naming.SessionName("claude", homeSID)]
	terminal.mu.Unlock()
	require.NotNil(t, pane)
	assert.Equal(t, own, pane.CurrentPath, "not started in the folder the link points to")
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
	assert.Equal(t, homeReal(t, newDir), pane.CurrentPath, "in the team's home folder, not the folder it last ran in")
	ls, err := ss.GetLiveSession(ctx, homeSID)
	require.NoError(t, err)
	assert.Equal(t, homeReal(t, newDir), ls.WorkingDir, "the row follows")
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
	assert.Equal(t, []string{homeReal(t, teamDir)}, term.restartDirs, "the pane was respawned in the team's home folder, not where it was")
}

// A team folder stored as a plain path that has since become a link starts the member where the link really goes, not where the stored text says (#10860).
func TestWakeFollowsALinkedTeamFolderToWhereItReallyIs(t *testing.T) {
	srv, _, terminal, ss, ts := homeFolderServer(t)
	ctx := context.Background()
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "team-home")
	require.NoError(t, os.Symlink(target, link))
	team, err := ts.CreateTeam(ctx, &store.Team{Name: "linked", ConfigJSON: "{}", WorkingDir: link})
	require.NoError(t, err)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: homeSID, AgentType: "claude", AgentName: "m", WorkingDir: t.TempDir(), IsSleeping: 1}))
	require.NoError(t, ss.SetTeamID(ctx, homeSID, team.ID))
	resp, err := http.Post(srv.URL+"/api/sessions/live/"+homeSID+"/wake", "application/json", strings.NewReader("{}"))
	require.NoError(t, err)
	resp.Body.Close()
	terminal.mu.Lock()
	pane := terminal.sessions[naming.SessionName("claude", homeSID)]
	terminal.mu.Unlock()
	require.NotNil(t, pane)
	assert.Equal(t, homeReal(t, target), pane.CurrentPath, "where the link really goes, never the link's own path")
}

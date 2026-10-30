//go:build windows

package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/linktest"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// junctionTo makes link a directory junction to target: no privilege is needed, so these run where the symbolic-link tests of team_home_folder_test.go skip.
func junctionTo(t *testing.T, target, link string) {
	t.Helper()
	out, err := consoletest.HiddenCommand("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	require.NoError(t, err, "mklink /J: %s", out)
}

// junctionLayer logs which layer decides for a junction here: Coral's (safefs follows it), or Windows' own (build 26300 and later refuse any path through a junction,
// "untrusted mount point", #350). Either way the tests below assert an outcome; none is skipped.
func junctionLayer(t *testing.T) bool {
	t.Helper()
	traversable := linktest.JunctionsTraversable(t)
	t.Logf("a junction is decided by: %s", map[bool]string{true: "Coral (safefs follows it)", false: "Windows (untrusted mount point)"}[traversable])
	return traversable
}

// The home folder through a junction, as TestSetTeamHomeFolderResolvesLinks does with symbolic links (#10860): a junction in the worktrees folder that leads out is never the
// team's own worktree; a junction to a folder is stored as the folder it leads to where Windows follows it, and refused, changing nothing, where Windows does not.
func TestSetTeamHomeFolderResolvesJunctions(t *testing.T) {
	traversable := junctionLayer(t)
	srv, handler, _, _, ts := homeFolderServer(t)
	ctx := context.Background()
	root := filepath.Join(handler.cfg.CoralDir(), "worktrees")
	require.NoError(t, os.MkdirAll(root, 0o755))
	junctionTo(t, t.TempDir(), filepath.Join(root, "wt")) // the team's own name, but a junction out
	_, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: filepath.Join(root, "wt"), IsWorktree: 1})
	require.NoError(t, err)
	code, body := putHomeFolder(t, srv.URL, "wt", filepath.Join(root, "wt"))
	assert.Equal(t, http.StatusBadRequest, code, "a junction out of the worktrees folder is not its own worktree: "+body)

	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "junction-to-folder")
	junctionTo(t, target, link)
	old := t.TempDir()
	_, err = ts.CreateTeam(ctx, &store.Team{Name: "plain", ConfigJSON: "{}", WorkingDir: old})
	require.NoError(t, err)
	code, body = putHomeFolder(t, srv.URL, "plain", link)
	got, _ := ts.GetTeam(ctx, "plain")
	if traversable {
		require.Equal(t, http.StatusOK, code, body)
		realTarget, err := safefs.Resolve(target)
		require.NoError(t, err)
		assert.Equal(t, realTarget, got.WorkingDir, "stored as the folder the junction leads to")
		assert.False(t, strings.EqualFold(link, got.WorkingDir), "never the junction's own path")
	} else {
		assert.Equal(t, http.StatusBadRequest, code, "a folder Windows will not open is refused: "+body)
		assert.Equal(t, old, got.WorkingDir, "a refused folder changes nothing")
	}
}

// At wake, as TestWakeResolvesTheTeamsFolderAgain and TestWakeFollowsALinkedTeamFolderToWhereItReallyIs do with symbolic links: a worktree team's folder swapped for a
// junction out is not followed (the member keeps its own folder); a plain folder that has since become a junction starts the member where the junction leads where
// Windows follows it, and in the member's own folder where Windows does not (a folder Coral can't open never stops a wake).
func TestWakeResolvesAJunctionedTeamFolder(t *testing.T) {
	traversable := junctionLayer(t)

	t.Run("a worktree swapped for a junction out", func(t *testing.T) {
		srv, handler, terminal, ss, ts := homeFolderServer(t)
		ctx := context.Background()
		root := filepath.Join(handler.cfg.CoralDir(), "worktrees")
		require.NoError(t, os.MkdirAll(root, 0o755))
		own := t.TempDir()
		team, err := ts.CreateTeam(ctx, &store.Team{Name: "wt", ConfigJSON: "{}", WorkingDir: filepath.Join(root, "wt"), IsWorktree: 1})
		require.NoError(t, err)
		junctionTo(t, t.TempDir(), filepath.Join(root, "wt"))
		assert.Equal(t, own, wakeAt(t, srv.URL, terminal, ss, team.ID, own), "not started in the folder the junction leads to")
	})

	t.Run("a plain folder that became a junction", func(t *testing.T) {
		srv, _, terminal, ss, ts := homeFolderServer(t)
		ctx := context.Background()
		target := t.TempDir()
		link := filepath.Join(t.TempDir(), "team-home")
		junctionTo(t, target, link)
		team, err := ts.CreateTeam(ctx, &store.Team{Name: "linked", ConfigJSON: "{}", WorkingDir: link})
		require.NoError(t, err)
		own := t.TempDir()
		got := wakeAt(t, srv.URL, terminal, ss, team.ID, own)
		if traversable {
			realTarget, err := safefs.Resolve(target)
			require.NoError(t, err)
			assert.Equal(t, realTarget, got, "where the junction really leads, never the junction's own path")
		} else {
			assert.Equal(t, own, got, "a team folder Windows will not open leaves the member in its own folder")
		}
	})
}

// wakeAt wakes a sleeping member of team teamID whose own folder is own, and answers the folder its pane was started in.
func wakeAt(t *testing.T, base string, terminal *mockSessionTerminal, ss *store.SessionStore, teamID int64, own string) string {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: homeSID, AgentType: "claude", AgentName: "m", WorkingDir: own, IsSleeping: 1}))
	require.NoError(t, ss.SetTeamID(ctx, homeSID, teamID))
	resp, err := http.Post(base+"/api/sessions/live/"+homeSID+"/wake", "application/json", strings.NewReader("{}"))
	require.NoError(t, err)
	resp.Body.Close()
	terminal.mu.Lock()
	pane := terminal.sessions[naming.SessionName("claude", homeSID)]
	terminal.mu.Unlock()
	require.NotNil(t, pane)
	return pane.CurrentPath
}

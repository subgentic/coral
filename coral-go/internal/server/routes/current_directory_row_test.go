package routes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/jsonl"
)

func gitForCurrentDir(t *testing.T, dir string, args ...string) {
	t.Helper()
	out, err := consoletest.HiddenCommand("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
}

// #11704: a Claude agent that has moved into its own worktree of the repository it was launched in is shown there (current_directory on its row); one that moved anywhere else, or whose transcript names no place,
// is shown where it was launched. working_directory stays the launch folder (a restart and a resume use it).
func TestARowSaysWhereTheAgentIsNowOnlyInsideItsOwnRepository(t *testing.T) {
	repo := t.TempDir()
	gitForCurrentDir(t, repo, "init", "-q", "-b", "main")
	gitForCurrentDir(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	wt := filepath.Join(t.TempDir(), "wt-a")
	gitForCurrentDir(t, repo, "worktree", "add", "-q", "-b", "feat-a", wt)
	outside := t.TempDir()

	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	require.NoError(t, os.MkdirAll(filepath.Join(projects, "proj"), 0o755))
	transcript := func(sid, cwd string) {
		quoted, err := json.Marshal(cwd) // a Windows path has backslashes: "\tmp" written raw is a tab in JSON
		require.NoError(t, err)
		line := `{"type":"assistant","cwd":` + string(quoted) + `,"message":{"content":[{"type":"text","text":"x"}]}}` + "\n"
		require.NoError(t, os.WriteFile(filepath.Join(projects, "proj", sid+".jsonl"), []byte(line), 0o644))
	}
	h := &SessionsHandler{}
	reader := jsonl.NewSessionReader()
	h.currentDir = background.NewCurrentDirFinder(reader.CurrentDirectory)

	sidA, sidB, sidC := "33333333-0000-4000-8000-00000000000a", "33333333-0000-4000-8000-00000000000b", "33333333-0000-4000-8000-00000000000c"
	transcript(sidA, wt)
	transcript(sidB, outside)
	assert.Equal(t, wt, h.currentDirectoryOf("claude", sidA, repo), "in its own worktree: shown there")
	assert.Equal(t, "", h.currentDirectoryOf("claude", sidB, repo), "in a folder that is not this repository's: not followed")
	assert.Equal(t, "", h.currentDirectoryOf("claude", sidC, repo), "no transcript: where it was launched")
	assert.Equal(t, "", h.currentDirectoryOf("codex", sidA, repo), "another agent's CLI: where it was launched")
	assert.Equal(t, "", (&SessionsHandler{}).currentDirectoryOf("claude", sidA, repo), "no finder set: where it was launched")
}

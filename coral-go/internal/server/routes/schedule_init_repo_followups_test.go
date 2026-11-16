package routes

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

func writeFiles(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, name := range names {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600))
	}
}

// #17487: the secret-name list covers .p8 keys, .git-credentials, .htpasswd, KeePass files and Terraform state and variables, and a file whose name holds a glob character is taken out as that file only: the
// other files a pattern would match stay in the commit (git rm took its arguments as pathspecs).
func TestFirstCommitSecretNamesAndLiteralPathspecs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	dir := t.TempDir()
	secrets := []string{"AuthKey.p8", ".git-credentials", ".htpasswd", "vault.kdbx", "terraform.tfstate", "terraform.tfstate.backup", "prod.tfvars", "a.auto.tfvars", "id_*"}
	keep := []string{"main.go", "id_rsa.pub", "terraform.tf"}
	writeFiles(t, dir, append(append([]string{}, secrets...), keep...)...)
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": dir, "include_files": true})
	require.Equal(t, http.StatusOK, code, "%v", body)
	out, err := consoletest.HiddenCommand("git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD").Output()
	require.NoError(t, err)
	assert.ElementsMatch(t, keep, strings.Fields(string(out)), "every secret-looking file is out and nothing else is (id_* is a file name, not a pattern that takes id_rsa.pub out too)")
	left, _ := body["left_out"].([]any)
	assert.Len(t, left, len(secrets), "%v", body["left_out"])
}

// #17487: the count is of what git add would take: a small project with a big ignored node_modules is a small project, for the folder picker and for the first commit alike.
func TestFirstCommitCountIgnoresWhatGitignoreExcludes(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	dir := t.TempDir()
	writeFiles(t, dir, ".gitignore", "main.go", "README.md")
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules/\n"), 0o644))
	for i := 0; i < 40; i++ {
		writeFiles(t, dir, "node_modules/pkg/f"+strconv.Itoa(i)+".js")
	}
	old := maxFirstCommitFiles
	maxFirstCommitFiles = 10
	t.Cleanup(func() { maxFirstCommitFiles = old })
	n, capped := countFolderFiles(context.Background(), dir, 10)
	assert.Equal(t, 3, n, "the three files git add would take")
	assert.False(t, capped)
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": dir, "include_files": true})
	assert.Equal(t, http.StatusOK, code, "a small project is not refused for its ignored folder: %v", body)
}

// #17487: a count stops at its time and a walk of many empty folders stops at a bound, so a folder pick stays quick on a slow disk.
func TestFolderCountIsBounded(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 60; i++ {
		require.NoError(t, os.MkdirAll(filepath.Join(dir, "d"+strconv.Itoa(i)), 0o755))
	}
	n, capped := walkCount(context.Background(), dir, 5)
	assert.True(t, capped, "sixty empty folders, no file: the walk gives up (%d files)", n)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, capped = countFolderFiles(ctx, dir, 20000)
	assert.True(t, capped, "out of time: reported as more than the limit")
	assert.Less(t, time.Since(start), 2*time.Second)
}

// #17487: when a first commit fails, only what Coral staged comes out of the index: a file the person staged first stays staged, and a secret-looking file they staged themselves is theirs to keep.
func TestFailedFirstCommitKeepsWhatThePersonStaged(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	require.NoError(t, consoletest.HiddenCommand("git", "init", "-q", dir).Run())
	writeFiles(t, dir, "mine.txt", ".env", "other.txt", "deploy.pem")
	require.NoError(t, consoletest.HiddenCommand("git", "-C", dir, "add", "mine.txt", ".env").Run())
	left, snap, err, _ := stageFirstCommit(context.Background(), dir)
	require.NoError(t, err)
	assert.Equal(t, []string{"deploy.pem"}, left, "the .env the person staged is not Coral's to take out")
	snap.undo(dir)
	out, err2 := consoletest.HiddenCommand("git", "-C", dir, "diff", "--cached", "--name-only").Output()
	require.NoError(t, err2)
	assert.ElementsMatch(t, []string{"mine.txt", ".env"}, strings.Fields(string(out)), "back to what the person had staged")
}

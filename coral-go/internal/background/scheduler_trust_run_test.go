package background

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #16421: a job whose Trust box is ticked trusts the worktree its run made for itself, only that, and takes the entry away with the worktree. A job without the tick trusts nothing.

func trustRunFixture(t *testing.T, tick int) (cfg string, worktreeDuringLaunch *string, run func() *store.ScheduledRun, repo, root string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo = t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"}} {
		out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	cfgDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	cfg = filepath.Join(cfgDir, ".claude.json")
	require.NoError(t, os.WriteFile(cfg, []byte(`{"projects": {}}`), 0o600))

	ss := store.NewScheduleStore(setupTestDB(t))
	ctx := context.Background()
	job, err := ss.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "nightly", CronExpr: "0 9 * * *", Timezone: "UTC", RepoPath: repo, Prompt: "p", Enabled: 1, TrustWorktree: tick, CleanupWorktree: 1})
	require.NoError(t, err)
	runID, err := ss.CreateScheduledRun(ctx, job.ID, time.Now().UTC().Format(store.ISOFormat), "pending")
	require.NoError(t, err)
	s := NewJobScheduler(ss, time.Minute)
	root = filepath.Join(t.TempDir(), "worktrees")
	s.SetWorktreeRoot(root)
	var during string
	worktreeDuringLaunch = &during
	s.SetLaunchFn(func(_ context.Context, j store.ScheduledJob, _ int64) error {
		b, _ := os.ReadFile(cfg)
		during = string(b)
		return nil
	})
	run = func() *store.ScheduledRun {
		s.launchAndWatch(runID, *job, runConfig{repoPath: repo, createWorktree: true, cleanupWorktree: true, maxDurationS: 30})
		r, err := ss.GetScheduledRun(ctx, runID)
		require.NoError(t, err)
		return r
	}
	return
}

func TestATickedJobTrustsItsRunsOwnWorktreeAndOnlyThat(t *testing.T) {
	cfg, during, run, repo, root := trustRunFixture(t, 1)
	r := run()
	require.NotNil(t, r.WorktreePath)
	wt := *r.WorktreePath
	assert.Equal(t, root, filepath.Dir(wt), "the run's worktree is directly inside the worktrees root")
	assert.Contains(t, *during, filepath.Base(wt), "while the agent launched, the run's own folder was trusted")
	assert.Contains(t, *during, `"hasTrustDialogAccepted": true`)
	assert.NotContains(t, *during, repo, "the job's own repository is not trusted")
	assert.NotContains(t, *during, `"`+root+`"`, "the worktrees root is not trusted")
	after, _ := os.ReadFile(cfg)
	assert.NotContains(t, string(after), filepath.Base(wt), "the entry went with the run's worktree")
}

func TestAJobWithoutTheTickTrustsNothing(t *testing.T) {
	cfg, during, run, _, _ := trustRunFixture(t, 0)
	_ = run()
	assert.NotContains(t, *during, "hasTrustDialogAccepted", "no entry is written for a job that is not ticked")
	after, _ := os.ReadFile(cfg)
	assert.JSONEq(t, `{"projects": {}}`, string(after))
}

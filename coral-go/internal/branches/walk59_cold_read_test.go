package branches

import (
	"context"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWalk59ColdRepositoryReadAfterTabKick(t *testing.T) {
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "sample.csv"), []byte("name,date\na.txt,2026-11-17\n"), 0600))
	runGit(t, dir, "add", "sample.csv")
	runGit(t, dir, "commit", "-q", "-m", "initial sample")
	c := New()
	_, _, ready := c.For(dir)
	require.False(t, ready)
	select {
	case <-c.Kicks():
	default:
		t.Fatal("the tab did not start a cold repository pass")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	start := time.Now()
	c.Observe(ctx, []string{dir})
	elapsed := time.Since(start)
	repo, index, ready := c.For(dir)
	require.True(t, ready, "a real git repository with a commit must leave the reading state")
	require.GreaterOrEqual(t, index, 0)
	require.Less(t, index, len(repo.Worktrees))
	require.Equal(t, "main", repo.Worktrees[index].Branch)
	require.NotEmpty(t, repo.Worktrees[index].Head)
	t.Logf("cold repository ready after tab kick: %s", elapsed)
}

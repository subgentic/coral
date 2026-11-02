package background

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
)

// #11949: the job removes the homes of no session, keeps those of a live or sleeping one, and removes nothing when the records cannot be read.
func TestHermesHomeSweepRemovesOnlyUnreachedHomes(t *testing.T) {
	data := t.TempDir()
	const live, orphan = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02"
	old := time.Now().Add(-48 * time.Hour)
	for _, id := range []string{live, orphan} {
		home := agent.HermesAgentHome(data, "team-a", id)
		require.NoError(t, os.MkdirAll(home, 0o700))
		require.NoError(t, os.Chtimes(home, old, old))
	}
	exists := func(id string) bool { _, err := os.Lstat(agent.HermesAgentHome(data, "team-a", id)); return err == nil }

	broken := NewHermesHomeSweep(data, func(context.Context) (map[string]bool, error) { return nil, errors.New("db closed") })
	assert.Zero(t, broken.RunOnce(context.Background()))
	assert.True(t, exists(orphan), "records that cannot be read remove nothing")

	job := NewHermesHomeSweep(data, func(context.Context) (map[string]bool, error) { return map[string]bool{live: true}, nil })
	assert.Equal(t, 1, job.RunOnce(context.Background()))
	assert.True(t, exists(live))
	assert.False(t, exists(orphan))
}

package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The assignment limit's question (#14862): who else could take this, by load.
func TestAgentLoadsAreCountedByWaitingTasksAndSortedFewestFirst(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "b.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for _, n := range []string{"Dev A", "Dev B", "Dev C"} {
		_, err := s.Subscribe(ctx, "team", n, "Developer", "claude-"+n, nil, "all")
		require.NoError(t, err)
	}
	_, err = s.Subscribe(ctx, "team", OperatorName, "Operator", "", nil, "all")
	require.NoError(t, err)
	mk := func(who string) {
		_, err := s.CreateTask(ctx, "team", "t", "", "medium", "Orchestrator", who)
		require.NoError(t, err)
	}
	mk("Dev A")
	mk("Dev A")
	mk("Dev A")
	mk("Dev B")
	loads, err := s.AgentLoads(ctx, "team")
	require.NoError(t, err)
	require.Len(t, loads, 3, "the Operator and members with no session of their own are not agents")
	assert.Equal(t, []string{"Dev C", "Dev B", "Dev A"}, []string{loads[0].Name, loads[1].Name, loads[2].Name}, "fewest waiting first")
	assert.Equal(t, []int{0, 1, 3}, []int{loads[0].Waiting, loads[1].Waiting, loads[2].Waiting})
	assert.Equal(t, "Developer", loads[0].Role)
	// a task that is claimed is not waiting
	_, err = s.ClaimTask(ctx, "team", "Dev A")
	require.NoError(t, err)
	loads, _ = s.AgentLoads(ctx, "team")
	for _, l := range loads {
		if l.Name == "Dev A" {
			assert.Equal(t, 2, l.Waiting, "an in-progress task is not a waiting one")
		}
	}
}

func TestTheAssignmentLimitIsATeamSettingOf3ByDefault(t *testing.T) {
	assert.Equal(t, 3, DefaultHealthSettings().AssignLimit)
	h := DefaultHealthSettings()
	h.AssignLimit = 500
	assert.Equal(t, 50, h.Clamp().AssignLimit)
	h.AssignLimit = -4
	assert.Equal(t, 0, h.Clamp().AssignLimit, "0 is no limit")
}

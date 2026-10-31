package board

import (
	"context"
	"fmt"
	"github.com/stretchr/testify/require"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkingModeClaimSnapshot(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer func() { s.Close() }()
	mode, err := s.GetWorkingMode(ctx, "team")
	require.NoError(t, err)
	require.Equal(t, "none", mode.Mode)
	_, err = s.SetWorkingMode(ctx, "team", WorkingMode{Mode: "worktrees", DependencyGuidance: true, CustomInstructions: "Run make check."})
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "Build", "", "medium", "lead")
	require.NoError(t, err)
	claimed, err := s.ClaimTask(ctx, "team", "dev", task.ID)
	require.NoError(t, err)
	require.Contains(t, claimed.Workflow.Instructions, "isolated Git worktree")
	require.Contains(t, claimed.Workflow.Instructions, "separate dependent tasks")
	require.Contains(t, claimed.Workflow.Instructions, "Run make check.")
	require.Equal(t, "worktrees", claimed.Workflow.TeamMode.Mode)
	original := claimed.Workflow.Instructions
	_, err = s.SetWorkingMode(ctx, "team", WorkingMode{Mode: "shared_checkout"})
	require.NoError(t, err)
	current, err := s.getTaskByID(ctx, "team", task.ID)
	require.NoError(t, err)
	require.Equal(t, original, current.Workflow.Instructions)
	_, err = s.ReassignTask(ctx, "team", task.ID, "other")
	require.NoError(t, err)
	reclaimed, err := s.ClaimTask(ctx, "team", "other", task.ID)
	require.NoError(t, err)
	require.Equal(t, original, reclaimed.Workflow.Instructions)
	s.Close()
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	mode, err = s.GetWorkingMode(ctx, "team")
	require.NoError(t, err)
	require.Equal(t, "shared_checkout", mode.Mode)
	next, err := s.CreateTask(ctx, "team", "Next", "", "medium", "lead")
	require.NoError(t, err)
	next, err = s.ClaimTask(ctx, "team", "newdev", next.ID)
	require.NoError(t, err)
	require.Contains(t, next.Workflow.Instructions, "shared checkout")
	_, err = s.SetWorkingMode(ctx, "team", WorkingMode{Mode: "invalid"})
	require.Error(t, err)
}

func TestNoneModeAddsNoInstructions(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	task, err := s.CreateTaskWithOpts(ctx, "team", "Default", "", "medium", "lead", &CreateTaskOpts{Workflow: TaskWorkflow{TeamMode: &WorkingMode{Mode: "worktrees"}}})
	require.NoError(t, err)
	task, err = s.ClaimTask(ctx, "team", "dev", task.ID)
	require.NoError(t, err)
	require.Equal(t, DefaultTaskWorkflowInstructions+"\n\nTeam working instructions:\n"+ReviewTagRule, task.Workflow.Instructions, "none mode adds only the review-tag rule")
	require.Equal(t, "none", task.Workflow.TeamMode.Mode)
}

// What makes a file the Operator's to look at is in the instructions every task is claimed with, for every team, with no team setting (#11424): both sides, so Needs you holds what the person must see and not every log.
func TestReviewTagRuleInEveryClaimedTask(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	claim := func(team, title string) string {
		task, err := s.CreateTask(ctx, team, title, "", "medium", "lead")
		require.NoError(t, err)
		claimed, err := s.ClaimTask(ctx, team, "dev", task.ID)
		require.NoError(t, err)
		return claimed.Workflow.Instructions
	}
	for _, want := range []string{`If the Operator needs to see, decide or approve an artifact, tag it "for review".`, "If it is for other agents or for yourself (logs, patches, notes, screenshots for a reviewer), do not tag it for review."} {
		require.Contains(t, ReviewTagRule, want)
	}
	require.Contains(t, claim("plain", "No settings at all"), ReviewTagRule)
	_, err = s.SetWorkingMode(ctx, "custom", WorkingMode{Mode: "worktrees", AsksAreTasks: true, CustomInstructions: "Run make check."})
	require.NoError(t, err)
	got := claim("custom", "A team with its own")
	require.Equal(t, 1, strings.Count(got, ReviewTagRule), "once, with a mode, the asks rule and custom instructions")
	require.Less(t, strings.Index(got, ReviewTagRule), strings.Index(got, "Run make check."), "the team's own words come after")
}

// "Requests for work are tasks" (goal #21): the setting is saved and read back, the rule is in the instructions a task is claimed with while it is on, and nowhere while it is off.
func TestAsksAreTasksRuleInClaimedInstructions(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()

	n := 0
	var firstID int64
	claim := func(team, title string) string {
		n++
		task, err := s.CreateTask(ctx, team, title, "", "medium", "lead")
		require.NoError(t, err)
		claimed, err := s.ClaimTask(ctx, team, fmt.Sprintf("dev%d", n), task.ID) // one agent per claim: an agent holds one task at a time
		require.NoError(t, err)
		if team == "team" && firstID == 0 {
			firstID = task.ID
		}
		return claimed.Workflow.Instructions
	}

	// A team that never set it keeps today's instructions.
	require.NotContains(t, claim("fresh", "Plain"), AsksAreTasksRule)

	saved, err := s.SetWorkingMode(ctx, "team", WorkingMode{Mode: "worktrees", AsksAreTasks: true, CustomInstructions: "Run make check."})
	require.NoError(t, err)
	require.True(t, saved.AsksAreTasks)
	require.Contains(t, saved.Instructions, AsksAreTasksRule)
	read, err := s.GetWorkingMode(ctx, "team")
	require.NoError(t, err)
	require.True(t, read.AsksAreTasks, "the switch is read back")
	on := claim("team", "With the rule")
	require.Contains(t, on, AsksAreTasksRule, "on: the claimed task carries the rule")
	require.Contains(t, on, "isolated Git worktree", "and the mode's own text")
	require.Less(t, strings.Index(on, AsksAreTasksRule), strings.Index(on, "Run make check."), "the rule sits before the team's own text")

	_, err = s.SetWorkingMode(ctx, "team", WorkingMode{Mode: "worktrees", AsksAreTasks: false})
	require.NoError(t, err)
	read, err = s.GetWorkingMode(ctx, "team")
	require.NoError(t, err)
	require.False(t, read.AsksAreTasks)
	require.NotContains(t, claim("team", "Without the rule"), AsksAreTasksRule, "off: the next claim does not carry it")
	kept, err := s.getTaskByID(ctx, "team", firstID)
	require.NoError(t, err)
	require.Contains(t, kept.Workflow.Instructions, AsksAreTasksRule, "a task already claimed keeps what it was claimed with")
}

package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21850: the archived flag is a board setting: set, read, listed, cleared; Remove team deletes it with the board's other settings.
func TestBoardArchivedFlag(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "docs-site", "Lead", "Orchestrator", "", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "billing", "Lead", "Orchestrator", "", nil, "all")
	require.NoError(t, err)

	assert.False(t, s.BoardArchived(ctx, "docs-site"))
	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", true))
	assert.True(t, s.BoardArchived(ctx, "docs-site"))
	assert.False(t, s.BoardArchived(ctx, "billing"))

	archived, err := s.ArchivedBoards(ctx)
	require.NoError(t, err)
	assert.Len(t, archived, 1)
	assert.NotEmpty(t, archived["docs-site"])

	projects, err := s.ListProjects(ctx)
	require.NoError(t, err)
	got := map[string]bool{}
	for _, p := range projects {
		got[p.Project] = p.Archived
	}
	assert.Equal(t, map[string]bool{"docs-site": true, "billing": false}, got)

	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", false))
	assert.False(t, s.BoardArchived(ctx, "docs-site"))
	archived, _ = s.ArchivedBoards(ctx)
	assert.Empty(t, archived)

	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", true))
	require.NoError(t, s.DeleteProject(ctx, "docs-site"), "Remove team is unchanged: an archived team can still be removed")
	assert.False(t, s.BoardArchived(ctx, "docs-site"), "and the flag goes with the board")
}

// #21850: the all-boards goal and task reads leave an archived team out, unless asked for or asked by board; Restore brings the rows back.
func TestArchivedTeamLeavesTheAllBoardsReads(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, b := range []string{"billing", "docs-site"} {
		_, err := s.Subscribe(ctx, b, "Lead", "Orchestrator", "", nil, "all")
		require.NoError(t, err)
		_, err = s.CreateGoal(ctx, b, GoalInput{Title: "Goal of " + b, CreatedBy: "Lead"})
		require.NoError(t, err)
	}
	boards := func(q AllGoalsQuery) []string {
		page, err := s.AllGoalsPage(ctx, q)
		require.NoError(t, err)
		var out []string
		for _, g := range page.Goals {
			out = append(out, g.BoardID)
		}
		return out
	}
	q := AllGoalsQuery{States: []string{"proposed", "active", "blocked"}, HideArchived: true}
	assert.ElementsMatch(t, []string{"billing", "docs-site"}, boards(q))
	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", true))
	assert.Equal(t, []string{"billing"}, boards(q), "an archived team's goals are not in the all-boards list")
	q.HideArchived = false
	assert.ElementsMatch(t, []string{"billing", "docs-site"}, boards(q), "unless they are asked for")
	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", false))
	q.HideArchived = true
	assert.ElementsMatch(t, []string{"billing", "docs-site"}, boards(q), "Restore brings them back")
}

func TestArchivedTeamLeavesTheAllBoardsTaskRead(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, b := range []string{"billing", "docs-site"} {
		_, err := s.CreateTask(ctx, b, "A task of "+b, "body", "medium", "Operator", "worker")
		require.NoError(t, err)
	}
	read := func(hide bool) []string {
		q, err := ParseTaskQuery(TaskQueryParams{})
		require.NoError(t, err)
		q.HideArchived = hide
		rows, _, err := s.QueryTaskRowsResult(ctx, q)
		require.NoError(t, err)
		n, err := s.CountTaskQuery(ctx, q)
		require.NoError(t, err)
		var out []string
		for _, r := range rows {
			out = append(out, r.BoardID)
		}
		assert.Equal(t, len(out), n, "the count agrees with the rows")
		return out
	}
	require.NoError(t, s.SetBoardArchived(ctx, "docs-site", true))
	assert.Equal(t, []string{"billing"}, read(true), "an archived team's tasks are not in the all-boards list")
	assert.ElementsMatch(t, []string{"billing", "docs-site"}, read(false), "a read that does not hide them still has them")
}

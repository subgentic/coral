package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func hitIDs(hits []WorkHit, source string) []int64 {
	var out []int64
	for _, h := range hits {
		if h.Source == source {
			out = append(out, h.ID)
		}
	}
	return out
}

func TestSearchWorkFindsTasksAndGoalsByTheirOwnFieldsAndSourceOnly(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	g, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Ship the thing", Outcome: "zebrafish habitat lands", DoneWhen: "quokka gate is green", CreatedBy: "op"})
	require.NoError(t, err)
	gid := g.ID
	tb, err := s.CreateTaskWithOpts(ctx, "alpha", "Plain title", "the body mentions narwhal", "high", "orch", &CreateTaskOpts{GoalID: &gid})
	require.NoError(t, err)
	tt, err := s.CreateTask(ctx, "alpha", "Axolotl in the title", "", "low", "orch")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "alpha", "orch", "a post about the pangolin", nil)
	require.NoError(t, err)

	for _, tc := range []struct {
		text, source string
		task, goal   []int64
	}{
		{"narwhal", "tasks", []int64{tb.ID}, nil},
		{"axolotl", "tasks", []int64{tt.ID}, nil},
		{"zebrafish", "goals", nil, []int64{g.ID}},
		{"quokka", "goals", nil, []int64{g.ID}},
	} {
		hits, more, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: tc.text, Sources: []string{"tasks", "goals"}, Limit: 20})
		require.NoError(t, err)
		require.False(t, more)
		require.Equal(t, tc.task, hitIDs(hits, "task"), tc.text)
		require.Equal(t, tc.goal, hitIDs(hits, "goal"), tc.text)
		// the wrong source finds nothing
		other := "goals"
		if tc.source == "goals" {
			other = "tasks"
		}
		hits, _, err = s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: tc.text, Sources: []string{other}, Limit: 20})
		require.NoError(t, err)
		require.Empty(t, hits, tc.text+" in "+other)
	}
	// a board post is not a task or goal hit
	hits, _, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "pangolin", Sources: []string{"tasks", "goals"}, Limit: 20})
	require.NoError(t, err)
	require.Empty(t, hits)
	// the hit shape
	hits, _, _ = s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "narwhal", Sources: []string{"tasks"}, Limit: 20})
	require.Len(t, hits, 1)
	h := hits[0]
	require.Equal(t, "Plain title", h.Title)
	require.Equal(t, "pending", h.State)
	require.NotNil(t, h.GoalID)
	require.Equal(t, g.ID, *h.GoalID)
	require.Contains(t, h.Snippet, "narwhal")
	require.NotEmpty(t, h.At)
}

func TestSearchWorkIsScopedToItsBoardAndTreatsWildcardsAsText(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := s.CreateTask(ctx, "alpha", "secret alpha task", "100% done_ish", "low", "orch")
	require.NoError(t, err)
	_, err = s.CreateTask(ctx, "beta", "secret beta task", "", "low", "orch")
	require.NoError(t, err)
	_, err = s.CreateGoal(ctx, "beta", GoalInput{Title: "secret beta goal", CreatedBy: "op"})
	require.NoError(t, err)
	hits, _, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "secret", Sources: []string{"tasks", "goals"}, Limit: 20})
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.Equal(t, "secret alpha task", hits[0].Title)
	for _, bad := range []string{"%", "_", "s_cret", "100%"} {
		hits, _, err = s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: bad, Sources: []string{"tasks"}, Limit: 20})
		require.NoError(t, err)
		if bad == "%" || bad == "100%" || bad == "_" {
			// "%" and "_" occur literally in the body: found only because the body has them
			require.LessOrEqual(t, len(hits), 1, bad)
		} else {
			require.Empty(t, hits, bad)
		}
	}
	hits, _, _ = s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "s_cret", Sources: []string{"tasks"}, Limit: 20})
	require.Empty(t, hits)
}

func TestSearchWorkFiltersAndLimit(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	g1, _ := s.CreateGoal(ctx, "alpha", GoalInput{Title: "g1 shared", CreatedBy: "op"})
	g2, _ := s.CreateGoal(ctx, "alpha", GoalInput{Title: "g2 shared", CreatedBy: "op"})
	a, _ := s.CreateTaskWithOpts(ctx, "alpha", "shared one", "", "low", "orch", &CreateTaskOpts{GoalID: &g1.ID}, "Dev")
	_, _ = s.CreateTaskWithOpts(ctx, "alpha", "shared two", "", "low", "orch", &CreateTaskOpts{GoalID: &g2.ID}, "QA")
	_, _ = s.CreateTask(ctx, "alpha", "shared three", "", "low", "orch")
	all := func(q WorkQuery) []WorkHit {
		q.Board, q.Text, q.Sources, q.Limit = "alpha", "shared", []string{"tasks"}, 20
		h, _, err := s.SearchWork(ctx, q)
		require.NoError(t, err)
		return h
	}
	require.Len(t, all(WorkQuery{}), 3)
	require.Equal(t, []int64{a.ID}, hitIDs(all(WorkQuery{GoalID: g1.ID}), "task"))
	require.Equal(t, []int64{a.ID}, hitIDs(all(WorkQuery{Assignee: "dev"}), "task"))
	require.Len(t, all(WorkQuery{State: "pending"}), 3)
	require.Empty(t, all(WorkQuery{State: "completed"}))
	hits, more, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "shared", Sources: []string{"tasks"}, Limit: 2})
	require.NoError(t, err)
	require.Len(t, hits, 2)
	require.True(t, more)
	// newest first
	require.Greater(t, hits[0].ID, hits[1].ID)
	// goals filter by goal id too
	gh, _, _ := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "shared", Sources: []string{"goals"}, GoalID: g2.ID, Limit: 20})
	require.Equal(t, []int64{g2.ID}, hitIDs(gh, "goal"))
}

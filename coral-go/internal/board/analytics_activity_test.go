package board

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func activityWindow() (string, string) {
	now := time.Now().UTC()
	return now.Add(-48 * time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339)
}

func TestBoardActivityCountsWhoTalksToWhom(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, n := range []string{"Orchestrator", "Backend Dev", "Backend Dev 2"} {
		_, err := sub(s, ctx, "team", n, n)
		require.NoError(t, err)
	}
	post := func(who, text string) {
		_, err := s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	post("Orchestrator", "@Backend Dev 2 please take #5, @Backend Dev FYI")
	post("Backend Dev 2", "@Orchestrator done; @Operator needs a look")
	post("Backend Dev", "no mentions here")
	post("Operator", "ship it")
	_, err := s.CreateTask(ctx, "team", "t1", "", "medium", "Orchestrator", "Backend Dev")
	require.NoError(t, err)

	since, until := activityWindow()
	a, err := s.BoardActivity(ctx, "team", since, until)
	require.NoError(t, err)
	require.Equal(t, 3, a.AgentPosts)
	require.Equal(t, 1, a.OperatorPosts)
	require.Equal(t, 1, a.Assigned)
	edges := map[string]int{}
	for _, e := range a.Edges {
		edges[e.From+">"+e.To] = e.Count
	}
	require.Equal(t, 1, edges["Orchestrator>Backend Dev 2"])
	require.Equal(t, 1, edges["Orchestrator>Backend Dev"])
	require.Equal(t, 1, edges["Backend Dev 2>Orchestrator"])
	require.Len(t, edges, 3, "'@Backend Dev 2' does not also tag 'Backend Dev'")
	for _, ag := range a.Agents {
		if ag.Name == "Backend Dev 2" {
			require.Equal(t, 1, ag.ToOperator)
		}
	}
	require.GreaterOrEqual(t, len(a.Days), 2, "the axis has a day for every day of the window")
}

func TestBoardActivityKeepsNoText(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := sub(s, ctx, "team", "Orchestrator", "Orchestrator")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "team", "Orchestrator", "SECRET-PHRASE @Operator", nil)
	require.NoError(t, err)
	since, until := activityWindow()
	a, err := s.BoardActivity(ctx, "team", since, until)
	require.NoError(t, err)
	b, err := jsonMarshalForTest(a)
	require.NoError(t, err)
	require.False(t, strings.Contains(b, "SECRET-PHRASE"), "an activity read returns counts only")
}

func TestBoardActivityRefusesAWindowPast90Days(t *testing.T) {
	s := testStore(t)
	now := time.Now().UTC()
	_, err := s.BoardActivity(context.Background(), "team", now.Add(-91*24*time.Hour).Format(time.RFC3339), now.Format(time.RFC3339))
	require.ErrorIs(t, err, ErrBadActivityWindow)
	_, err = s.BoardActivity(context.Background(), "team", now.Format(time.RFC3339), now.Add(-time.Hour).Format(time.RFC3339))
	require.ErrorIs(t, err, ErrBadActivityWindow)
}

func jsonMarshalForTest(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

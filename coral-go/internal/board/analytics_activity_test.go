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

func TestBoardActivityCountsTheTeamPairs(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := sub(s, ctx, "alpha", "Orchestrator", "Orchestrator")
	require.NoError(t, err)
	send := func(from, to string) {
		_, _, err := s.PostCrossTeamMessage(ctx, CrossTeamPost{Origin: MessageOrigin{ServerID: "local", Board: from, Sender: "Orchestrator", SenderRole: "Orchestrator", TargetServerID: "local", TargetBoard: to}, Content: "PRIVATE-PAIR-TEXT"})
		require.NoError(t, err)
	}
	send("alpha", "beta")
	send("alpha", "beta")
	send("alpha", "gamma")
	send("beta", "alpha")
	g := newGoal(t, s, "alpha", "Ship it")
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "do it", "Lead", nil)
	require.NoError(t, err)
	_ = in
	since, until := activityWindow()
	a, err := s.BoardActivity(ctx, "alpha", since, until)
	require.NoError(t, err)
	got := map[string]ActivityPair{}
	for _, p := range a.Pairs {
		got[p.From+">"+p.To] = p
	}
	require.Equal(t, 2, got["alpha>beta"].Messages, "two messages from alpha to beta")
	require.Equal(t, 1, got["alpha>beta"].Requests, "and one goal request")
	require.Equal(t, 1, got["alpha>gamma"].Messages)
	require.Equal(t, 1, got["beta>alpha"].Messages, "the inbound copy is beta asking alpha")
	require.Len(t, got, 3)
	require.Equal(t, 4, a.CrossPosts, "every cross-team copy on this board is one cross post")
	b, err := jsonMarshalForTest(a)
	require.NoError(t, err)
	require.False(t, strings.Contains(b, "PRIVATE-PAIR-TEXT"), "pairs are counts, never text")
}

func TestAskWaitMedianIsTheMeanOfTheTwoMiddleOnesForAnEvenCount(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := sub(s, ctx, "team", "Backend Dev", "Backend Dev")
	require.NoError(t, err)
	base := time.Now().UTC().Add(-3 * time.Hour)
	for i, wait := range []time.Duration{2 * time.Minute, 20 * time.Minute} {
		m, err := s.PostMessage(ctx, "team", "Backend Dev", "question @Operator", nil)
		require.NoError(t, err)
		require.NoError(t, s.RecordAsk(ctx, "team", m, []string{"Operator"}))
		r, err := s.PostMessage(ctx, "team", "Operator", "answer", nil)
		require.NoError(t, err)
		require.NoError(t, s.RecordReply(ctx, "team", r.ID, m.ID))
		at := base.Add(time.Duration(i) * time.Hour)
		_, err = s.Writer().ExecContext(ctx, `UPDATE board_messages SET created_at = ? WHERE id = ?`, at.Format(time.RFC3339), m.ID)
		require.NoError(t, err)
		_, err = s.Writer().ExecContext(ctx, `UPDATE board_asks SET created_at = ? WHERE message_id = ?`, at.Format(time.RFC3339), m.ID)
		require.NoError(t, err)
		_, err = s.Writer().ExecContext(ctx, `UPDATE board_messages SET created_at = ? WHERE id = ?`, at.Add(wait).Format(time.RFC3339), r.ID)
		require.NoError(t, err)
	}
	since, until := activityWindow()
	a, err := s.BoardActivity(ctx, "team", since, until)
	require.NoError(t, err)
	require.NotNil(t, a.OperatorAsks.MedianS)
	require.Equal(t, float64(11*60), *a.OperatorAsks.MedianS, "waits of 2 and 20 minutes: the median is 11 minutes, not 20")
	require.Equal(t, float64(20*60), *a.OperatorAsks.SlowestS)
}

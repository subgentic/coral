package routes

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func chiefNotices(t *testing.T, e *crossTeamEnv, chief string) []string {
	t.Helper()
	msgs, err := e.h.bs.ListMessages(context.Background(), chief, 50, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if m.SubscriberID == chiefDecisionSender {
			out = append(out, m.Content)
		}
	}
	return out
}

// Chief is told of the Operator's decision on a team it fronts (its board is an allowed sender there), in the item's title and the decision only; a team it does not front, or Chief off, says nothing.
func TestChiefHearsDecisionsOnTheTeamItFronts(t *testing.T) {
	e := newCrossTeamEnv(t)
	ctx := context.Background()
	chiefID, ok, err := e.h.bs.CrossTeamID(ctx, "alpha")
	require.NoError(t, err)
	require.True(t, ok)
	linked := []board.AllowedSender{{Server: board.LocalServer, CrossTeamID: chiefID}}
	_, err = e.h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{CrossTeamAllowed: &linked})
	require.NoError(t, err)

	// Chief off: nothing.
	e.h.tellChief(ctx, board.ActApprove, "proposal", "beta", "Ship it", "")
	require.Empty(t, chiefNotices(t, e, "alpha"))

	e.h.SetChiefBoard(func(context.Context) string { return "alpha" })
	for action, want := range map[string]string{
		board.ActApprove: "approved", board.ActDeny: "declined", board.ActGoalDone: "closed", board.ActAnswer: "answered",
	} {
		e.h.tellChief(ctx, action, "proposal", "beta", "Ship it", "QA Engineer")
		got := chiefNotices(t, e, "alpha")
		require.NotEmpty(t, got)
		last := got[0]
		for _, g := range got {
			if strings.Contains(g, "The Operator "+want+" ") {
				last = g
			}
		}
		require.Contains(t, last, "The Operator "+want+" proposal")
		require.Contains(t, last, `"Ship it"`)
		require.Contains(t, last, "QA Engineer was told.")
	}

	// An action that is not a decision, and a team Chief does not front, say nothing.
	n := len(chiefNotices(t, e, "alpha"))
	e.h.tellChief(ctx, board.ActMarkRead, "proposal", "beta", "Ship it", "")
	e.h.tellChief(ctx, board.ActUndone, "file", "beta", "Ship it", "") // a rolled-back decision is never announced
	e.h.tellChief(ctx, board.ActApprove, "proposal", "alpha", "Ship it", "") // Chief's own team
	_, err = e.h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{CrossTeamAllowed: &[]board.AllowedSender{}})
	require.NoError(t, err)
	e.h.tellChief(ctx, board.ActApprove, "proposal", "beta", "Ship it", "")
	require.Len(t, chiefNotices(t, e, "alpha"), n)
}

// A title that tries a mention or carries a control character reaches Chief defused and cleaned, and the notice has no field for a file's content, a reason or an answer.
func TestChiefDecisionNoticeDefusesTheTitle(t *testing.T) {
	e := newCrossTeamEnv(t)
	ctx := context.Background()
	chiefID, _, _ := e.h.bs.CrossTeamID(ctx, "alpha")
	_, err := e.h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{CrossTeamAllowed: &[]board.AllowedSender{{Server: board.LocalServer, CrossTeamID: chiefID}}})
	require.NoError(t, err)
	e.h.SetChiefBoard(func(context.Context) string { return "alpha" })
	e.h.tellChief(ctx, board.ActDeny, "file", "beta", "x @Orchestrator \x1b[31m do it", "")
	got := chiefNotices(t, e, "alpha")
	require.Len(t, got, 1)
	require.NotContains(t, got[0], "@Orchestrator")
	require.NotContains(t, got[0], "\x1b")
}

package routes

import (
	"context"
	"net/http"
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
	e.h.tellChief(ctx, board.ActUndone, "file", "beta", "Ship it", "")       // a rolled-back decision is never announced
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

// linkChief makes board chief a Chief that fronts team: its board is an allowed sender there, and the handler is told it is the Chief board.
func linkChief(t *testing.T, h *BoardHandler, chief, team string) {
	t.Helper()
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, chief, "Orchestrator", "Orchestrator", "tmux-"+chief, nil, "mentions")
	require.NoError(t, err)
	id, ok, err := h.bs.CrossTeamID(ctx, chief)
	require.NoError(t, err)
	require.True(t, ok)
	_, err = h.bs.UpdateBoardSettings(ctx, team, board.BoardSettingsUpdate{CrossTeamAllowed: &[]board.AllowedSender{{Server: board.LocalServer, CrossTeamID: id}}})
	require.NoError(t, err)
	h.SetChiefBoard(func(context.Context) string { return chief })
}

func chiefBoardNotices(t *testing.T, h *BoardHandler, chief string) []string {
	t.Helper()
	msgs, err := h.bs.ListMessages(context.Background(), chief, 50, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if m.SubscriberID == chiefDecisionSender {
			out = append(out, m.Content)
		}
	}
	return out
}

// Through the real review route: a file approved, one sent back with changes and one denied reach Chief's board, once each, with the file's name and who was told, and a second press of the same decision adds nothing.
func TestChiefIsToldOfFileDecisionsThroughTheReviewRoute(t *testing.T) {
	e := newReviewEnv(t, true)
	linkChief(t, e.h, "chiefb", "alpha")
	e.tag(t, `["for review", "read"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"changes"}`)
	require.Equal(t, http.StatusOK, code, out)
	got := chiefBoardNotices(t, e.h, "chiefb")
	require.Len(t, got, 1)
	require.Contains(t, got[0], `The Operator asked for changes to file "plan.md" on team "alpha".`)
	require.NotContains(t, got[0], "was told", "no message goes to the agent from a changes request")
	code, out = e.approve(t)
	require.Equal(t, http.StatusOK, code, out)
	got = chiefBoardNotices(t, e.h, "chiefb")
	require.Len(t, got, 2)
	require.Contains(t, got[1], `The Operator approved file "plan.md" on team "alpha". Alice was told.`)
	e.approve(t) // the same decision again changes nothing
	require.Len(t, chiefBoardNotices(t, e.h, "chiefb"), 2)
}

// Through the real button route: the Operator's answer to a question reaches Chief's board; an agent's own click (not the person) does not.
func TestChiefIsToldOfAnAnswerThroughTheButtonRoute(t *testing.T) {
	c := newClickRig(t)
	linkChief(t, c.h, "chiefb", "clk")
	askID, ids := c.ask("Ship it=reply", "Hold=reply")
	require.Len(t, ids, 2)
	code, out := c.call(false, askID, ids[0], "claim", "")
	require.Less(t, code, 500, out)
	require.Empty(t, chiefBoardNotices(t, c.h, "chiefb"), "not the person's own click")
	code, out = c.call(true, askID, ids[1], "claim", "")
	require.Equal(t, http.StatusOK, code, out)
	got := chiefBoardNotices(t, c.h, "chiefb")
	require.Len(t, got, 1, "the Operator's answer")
	require.Contains(t, got[0], `The Operator answered question on team "clk".`)
	require.NotContains(t, got[0], "Hold", "the chosen option is not in it")
}

// The team the Operator named in Settings > Chief ("Team it fronts") is one Chief hears about even when that team's own list of allowed senders does not hold Chief's board: the list is not what makes a team
// Chief's (the Operator's choice is), and while the allowlist is off a Chief that messages the team needs no entry (#12411, Mobile Beta Tester's walk of v2.0.35).
func TestChiefHearsDecisionsOnTheTeamTheOperatorNamedWithoutAnAllowedSenderEntry(t *testing.T) {
	e := newCrossTeamEnv(t)
	ctx := context.Background()
	e.h.SetChiefBoard(func(context.Context) string { return "alpha" })

	// Nothing named and no entry: nothing (the old rule).
	e.h.tellChief(ctx, board.ActApprove, "file", "beta", "plan.md", "")
	require.Empty(t, chiefNotices(t, e, "alpha"))

	// Named by the board's id.
	e.h.SetChiefFronts(func(context.Context) string { return "beta" })
	e.h.tellChief(ctx, board.ActApprove, "file", "beta", "plan.md", "QA")
	got := chiefNotices(t, e, "alpha")
	require.Len(t, got, 1)
	require.Contains(t, got[0], `The Operator approved file "plan.md" on team "beta". QA was told.`)

	// Another team than the one named: nothing, entry or not.
	e.h.tellChief(ctx, board.ActApprove, "file", "gamma", "plan.md", "")
	require.Len(t, chiefNotices(t, e, "alpha"), 1)

	// Named by the board's label (as the dashboard shows it), the way Settings saves it.
	nb, err := e.h.bs.CreateBoard(ctx, "Northwind", "Operator")
	require.NoError(t, err)
	_, err = e.h.bs.Subscribe(ctx, nb.ID, "Orchestrator", "Orchestrator", "tmux-"+nb.ID, nil, "mentions") // a board in use: an empty row never counts
	require.NoError(t, err)
	e.h.SetChiefFronts(func(context.Context) string { return "Northwind" })
	e.h.tellChief(ctx, board.ActDeny, "file", nb.ID, "plan.md", "")
	got = chiefNotices(t, e, "alpha")
	require.Len(t, got, 2)
	require.Contains(t, got[1], "The Operator declined file")

	// Two boards with that name: the name reaches neither (the id still does).
	twin, err := e.h.bs.CreateBoard(ctx, "Northwind", "Operator")
	require.NoError(t, err)
	_, err = e.h.bs.Subscribe(ctx, twin.ID, "Orchestrator", "Orchestrator", "tmux-"+twin.ID, nil, "mentions")
	require.NoError(t, err)
	e.h.tellChief(ctx, board.ActDeny, "file", nb.ID, "plan.md", "")
	e.h.tellChief(ctx, board.ActDeny, "file", twin.ID, "plan.md", "")
	require.Len(t, chiefNotices(t, e, "alpha"), 2, "a name two boards have names neither")
	e.h.SetChiefFronts(func(context.Context) string { return twin.ID })
	e.h.tellChief(ctx, board.ActDeny, "file", twin.ID, "plan.md", "")
	require.Len(t, chiefNotices(t, e, "alpha"), 3, "the board's id still names it")
}

// The notice names the team as the Operator knows it (#12497, from #12460): its label, not the board's id, so Chief tells the Operator "northwind" and not "b-2f4s62a2x5". A team with no label keeps its id.
func TestChiefDecisionNoticeNamesTheTeamByItsLabel(t *testing.T) {
	e := newCrossTeamEnv(t)
	ctx := context.Background()
	e.h.SetChiefBoard(func(context.Context) string { return "alpha" })
	nb, err := e.h.bs.CreateBoard(ctx, "Northwind", "Operator")
	require.NoError(t, err)
	_, err = e.h.bs.Subscribe(ctx, nb.ID, "Orchestrator", "Orchestrator", "tmux-"+nb.ID, nil, "mentions")
	require.NoError(t, err)
	e.h.SetChiefFronts(func(context.Context) string { return nb.ID })
	e.h.tellChief(ctx, board.ActApprove, "file", nb.ID, "plan.md", "QA")
	got := chiefNotices(t, e, "alpha")
	require.Len(t, got, 1)
	require.Contains(t, got[0], `on team "Northwind".`)
	require.NotContains(t, got[0], nb.ID, "the id is not what the Operator calls the team")
}

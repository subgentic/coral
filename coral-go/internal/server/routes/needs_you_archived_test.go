package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21915: a team that is put away asks nothing of the Operator: its questions, waits and proposals leave Needs you (as its review files do: they are read in the same per-team pass), and come back when it is restored.
func TestNeedsYouLeavesOutAnArchivedTeam(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "put-away", "Lead", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "put-away", q, []string{"Operator"}))
	_, err = bs.RegisterWait(ctx, "put-away", "Dev", "claude-x", board.WaitOperator, "", "may I delete the old table?", 3600e9)
	require.NoError(t, err)
	_, _, err = bs.CreateProposal(ctx, board.ProposalInput{Board: "put-away", Kind: board.ProposalTask, Title: "Add the export", Payload: json.RawMessage(`{"title":"Add the export"}`), Proposer: "Lead"})
	require.NoError(t, err)

	_, out := readNeedsYou(t, h, "", asPerson)
	assert.EqualValues(t, 3, out["count"], "the live team asks")
	require.NoError(t, bs.SetBoardArchived(ctx, "put-away", true))
	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 0, out["count"], "an archived team asks nothing: %v", out)
	require.NoError(t, bs.SetBoardArchived(ctx, "put-away", false))
	_, out = readNeedsYou(t, h, "", asPerson)
	assert.EqualValues(t, 3, out["count"], "restored, the rows are back: nothing was closed")
}

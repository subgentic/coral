package board

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19828: a file's decision keeps the question the agent asked with the file. A row made before the column has none and hashes as it always did; a row made after it hashes the question too, chains the old one,
// and a question edited outside Coral breaks the chain like any other field. The chain is checked across a pre-change row and a post-change row.
func TestAFilesDecisionKeepsItsQuestionAndTheChainHoldsAcrossAnOldAndANewRow(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()

	// a row as the record made it before the column: the hash is of the thirteen fields only, and the insert names no ask column
	old := OperatorAction{At: "2026-11-01T10:00:00.000Z", Actor: "local", Action: ActIgnore, ItemKind: "file", ItemID: strings.Repeat("a", 64), Team: "p", Source: "local", Title: "plan.md", Note: "old"}
	old.Hash = activityHash("", old)
	_, err := s.db.ExecContext(ctx, `INSERT INTO operator_actions (at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note, prev_hash, hash) VALUES (?, ?, ?, ?, ?, '', ?, ?, '', '', ?, ?, '', ?)`,
		old.At, old.Actor, old.Action, old.ItemKind, old.ItemID, old.Team, old.Source, old.Title, old.Note, old.Hash)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT INTO operator_actions_head (one, last_id, last_hash, first_id, first_prev_hash) VALUES (1, 1, ?, 1, '') ON CONFLICT(one) DO UPDATE SET last_id = 1, last_hash = excluded.last_hash, first_id = 1, first_prev_hash = ''`, old.Hash)
	require.NoError(t, err)

	m := opMeta
	m.Title, m.Ask = "plan.md", "Approve these Inbox list polish mocks?"
	require.NoError(t, s.RecordActivity(ctx, m, ActIgnore, "file", strings.Repeat("b", 64), "", "p"))
	m.Ask = "" // a file sent with no question: a row with none, hashed as before
	require.NoError(t, s.RecordActivity(ctx, m, ActIgnore, "file", strings.Repeat("c", 64), "", "p"))

	rows, _, err := s.ActivityPage(ctx, ActivityFilter{Limit: 10}) // newest first
	require.NoError(t, err)
	require.Len(t, rows, 3)
	assert.Empty(t, rows[0].Ask)
	assert.Equal(t, "Approve these Inbox list polish mocks?", rows[1].Ask, "the question is kept beside the file's name")
	assert.Empty(t, rows[2].Ask, "an old row has none and is not guessed at")

	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the old row's hash is unchanged, the new row hashes its question and chains the old one: %+v", chk)

	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET ask = 'Approve everything?' WHERE id = 2`)
	require.NoError(t, err)
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "a question edited outside Coral is a break like any other field")
	assert.EqualValues(t, 2, chk.FirstBad)

	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET ask = '' WHERE id = 2`)
	require.NoError(t, err)
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "a question taken off a row that hashed it is a break too")
}

// The question is text an agent chose: cleaned and cut at the length it is stored at.
func TestAFilesQuestionIsCleanedAndCut(t *testing.T) {
	s := activityStore(t)
	m := opMeta
	m.Title, m.Ask = "plan.md", "Ship\u202e it?\u200b "+strings.Repeat("x", 400)
	require.NoError(t, s.RecordActivity(context.Background(), m, ActIgnore, "file", strings.Repeat("a", 64), "", "p"))
	rows, _, err := s.ActivityPage(context.Background(), ActivityFilter{Limit: 5})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.NotContains(t, rows[0].Ask, "\u202e")
	assert.NotContains(t, rows[0].Ask, "\u200b")
	assert.LessOrEqual(t, len([]rune(rows[0].Ask)), activityAskCap+1)
}

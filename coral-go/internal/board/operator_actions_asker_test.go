package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14422: a row about an ask keeps the ask's line as its title and who asked beside it. A row made before the field has no asker and hashes as it always did, so the chain still verifies; an edited asker is a break.
func TestARowKeepsWhoAskedAndAnOldRowStillVerifies(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()

	// a row as the record made it before the field: the hash is of the thirteen fields only
	old := OperatorAction{At: "2026-11-01T10:00:00.000Z", Actor: "local", Action: ActIgnore, ItemKind: "question", ItemID: "5", Team: "p", Source: "local", Title: "", Note: "old"}
	old.Hash = activityHash("", old)
	_, err := s.db.ExecContext(ctx, `INSERT INTO operator_actions (at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note, prev_hash, hash) VALUES (?, ?, ?, ?, ?, '', ?, ?, '', '', ?, ?, '', ?)`,
		old.At, old.Actor, old.Action, old.ItemKind, old.ItemID, old.Team, old.Source, old.Title, old.Note, old.Hash)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT INTO operator_actions_head (one, last_id, last_hash, first_id, first_prev_hash) VALUES (1, 1, ?, 1, '') ON CONFLICT(one) DO UPDATE SET last_id = 1, last_hash = excluded.last_hash, first_id = 1, first_prev_hash = ''`, old.Hash)
	require.NoError(t, err)

	m := opMeta
	m.Title, m.Asker = "Ship batch-120 tonight?", "Head of Security"
	require.NoError(t, s.RecordActivity(ctx, m, ActIgnore, "question", "6", "", "p"))

	rows, _, err := s.ActivityPage(ctx, ActivityFilter{Limit: 10}) // newest first
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "Ship batch-120 tonight?", rows[0].Title)
	assert.Equal(t, "Head of Security", rows[0].Asker, "the asker is kept beside the ask's line")
	assert.Empty(t, rows[1].Asker, "an old row has none and is not guessed at")

	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the old row's hash is unchanged and the new row chains it: %+v", chk)

	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET asker = 'someone else' WHERE id = 2`)
	require.NoError(t, err)
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "an asker edited outside Coral is a break like any other field")
	assert.EqualValues(t, 2, chk.FirstBad)
}

// An asker is text an agent chose: cleaned and cut like the title, so it cannot carry a reordering character or a wall of text.
func TestTheAskerIsCleanedAndCut(t *testing.T) {
	s := activityStore(t)
	m := opMeta
	m.Title, m.Asker = "q", "Head\u202e of\u200b Security "+string(make([]rune, 0))+"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	require.NoError(t, s.RecordActivity(context.Background(), m, ActIgnore, "question", "1", "", "p"))
	rows, _, err := s.ActivityPage(context.Background(), ActivityFilter{Limit: 5})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.NotContains(t, rows[0].Asker, "\u202e")
	assert.NotContains(t, rows[0].Asker, "\u200b")
	assert.LessOrEqual(t, len([]rune(rows[0].Asker)), activityAskerCap+1)
}

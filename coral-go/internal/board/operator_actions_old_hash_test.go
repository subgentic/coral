package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14488 (QA Reviewer 2's SHOULD on #14422 and #14421): a row made before the asker, goal_id and task_id columns keeps its hash. The two constants below were computed by the code as it was at origin/main
// d4e1ee9b9, before either change, and are written here as literals: the chain over such rows must verify, and the current hash function must give exactly these. A change that made the asker (or the goal and
// task) always join the hash would give these rows other hashes and fail here, where a test that computes its expected hash with the same function cannot.
const (
	oldRowHash1 = "6dd729e6e4b4e997517ec044047f237d4745bf281b535b212057f79e95a94636"
	oldRowHash2 = "e5c231d6b1d36a4e174852bf0caeed57f25574f0f1fa1b3b4e523ac1a67514b4"
)

func oldRow1() OperatorAction {
	return OperatorAction{At: "2026-11-01T10:00:00.000Z", Actor: "local", Action: ActIgnore, ItemKind: "question", ItemID: "5", Team: "p", Source: "local", Title: "old title", Note: "old note"}
}

func oldRow2() OperatorAction {
	const digest = "00000000000000000000000000000000000000000000000000000000000000aa"
	return OperatorAction{At: "2026-11-01T10:05:00.000Z", Actor: "hub:abc123", Action: ActApprove, ItemKind: "file", ItemID: digest, Version: digest, Team: "p", Source: "hub", Hint: "phone", Surface: "inbox", Title: "plan.md", Note: "looks good"}
}

func TestAnOldRowsHashIsTheOneTheOldCodeGave(t *testing.T) {
	assert.Equal(t, oldRowHash1, activityHash("", oldRow1()), "a row with no asker, goal or task hashes as it did before the columns")
	assert.Equal(t, oldRowHash2, activityHash(oldRowHash1, oldRow2()), "and so does the second, chained to the first")
}

func TestTheChainVerifiesOverRowsWhoseHashesAreLiterals(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	for i, r := range []struct {
		a          OperatorAction
		prev, hash string
	}{{oldRow1(), "", oldRowHash1}, {oldRow2(), oldRowHash1, oldRowHash2}} {
		a := r.a
		_, err := s.db.ExecContext(ctx, `INSERT INTO operator_actions (at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			a.At, a.Actor, a.Action, a.ItemKind, a.ItemID, a.Version, a.Team, a.Source, a.Hint, a.Surface, a.Title, a.Note, r.prev, r.hash)
		require.NoError(t, err, "row %d", i+1)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO operator_actions_head (one, last_id, last_hash, first_id, first_prev_hash) VALUES (1, 2, ?, 1, '') ON CONFLICT(one) DO UPDATE SET last_id = 2, last_hash = excluded.last_hash, first_id = 1, first_prev_hash = ''`, oldRowHash2)
	require.NoError(t, err)
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the old rows verify with no asker, goal or task: %+v", chk)
	assert.EqualValues(t, 2, chk.Rows)

	// a new row after them chains the literal hash and verifies too
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActIgnore, "question", "9", "", "p"))
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "a new row chains the old one's literal hash: %+v", chk)
}

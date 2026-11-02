package board

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12069: the Activity record. Each row chains the one before it, the decisions write their row in their own transaction, and an edit outside Coral shows as a break.

func activityStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

var opMeta = ActivityMeta{Actor: "local", Source: "local"}

func hexN(n int) string { return strings.Repeat(fmt.Sprintf("%x", n%16), 64) }

func (s *Store) forReview(t *testing.T, boardID, hex string) {
	t.Helper()
	require.NoError(t, s.SetArtifactTags(context.Background(), boardID, hex, []string{"for review"}))
}

func TestEachFileDecisionWritesItsRowInItsOwnTransactionWithTheVersionActedOn(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), ActivityMeta{Actor: "local", Source: "local", Hint: "phone", Title: "Plan‮.md"})
	for i, tc := range []struct{ state, want string }{{ReviewApproved, ActApprove}, {ReviewChangesRequested, ActChanges}, {ReviewDenied, ActDeny}} {
		hex := hexN(i + 1)
		s.forReview(t, "team-a", hex)
		_, _, err := s.DecideArtifactReview(ctx, "team-a", hex, tc.state, time.Now())
		require.NoError(t, err)
		rows, err := s.ListActivity(context.Background(), ActivityFilter{})
		require.NoError(t, err)
		require.Equal(t, tc.want, rows[0].Action)
		assert.Equal(t, hex, rows[0].ItemID)
		assert.Equal(t, hex, rows[0].Version, "the digest of the exact version decided")
		assert.Equal(t, "team-a", rows[0].Team)
		assert.Equal(t, "phone", rows[0].Hint)
		assert.Equal(t, "Plan.md", rows[0].Title, "a reordering character from an agent's file name is stripped")
	}
	// ignore, unignore, save and unsave
	hex := hexN(9)
	s.forReview(t, "team-a", hex)
	_, _, err := s.SaveArtifactReview(ctx, "team-a", hex, true)
	require.NoError(t, err)
	_, _, err = s.SaveArtifactReview(ctx, "team-a", hex, false)
	require.NoError(t, err)
	_, _, err = s.IgnoreArtifactReview(ctx, "team-a", hex, true)
	require.NoError(t, err)
	_, _, err = s.IgnoreArtifactReview(ctx, "team-a", hex, false)
	require.NoError(t, err)
	rows, _ := s.ListActivity(context.Background(), ActivityFilter{Limit: 4})
	var got []string
	for _, r := range rows {
		got = append(got, r.Action)
	}
	assert.Equal(t, []string{ActUnignore, ActIgnore, ActUnsave, ActSave}, got)
	chk, err := s.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.True(t, chk.Intact, "%+v", chk)
}

func TestARefusedOrUnchangedActionLeavesNoRowAndNoContextLeavesNone(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), opMeta)
	hex := hexN(1)
	_, _, err := s.DecideArtifactReview(ctx, "team-a", hex, ReviewApproved, time.Now()) // not for review
	assert.ErrorIs(t, err, ErrNotForReview)
	s.forReview(t, "team-a", hexN(2))
	_, _, err = s.DecideArtifactReview(context.Background(), "team-a", hexN(2), ReviewApproved, time.Now()) // a call that is not the Operator's request records nothing
	require.NoError(t, err)
	rows, _ := s.ListActivity(context.Background(), ActivityFilter{})
	assert.Empty(t, rows)
}

func TestARolledBackDecisionIsRecordedAsUndoneNotErased(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), opMeta)
	hex := hexN(3)
	s.forReview(t, "team-a", hex)
	ch, _, err := s.DecideArtifactReview(ctx, "team-a", hex, ReviewApproved, time.Now())
	require.NoError(t, err)
	require.NoError(t, s.UndoArtifactReview(ctx, ch))
	rows, _ := s.ListActivity(context.Background(), ActivityFilter{})
	require.Len(t, rows, 2)
	assert.Equal(t, ActUndone, rows[0].Action)
	assert.Equal(t, ActApprove, rows[1].Action, "the approval stays in the record")
	chk, _ := s.VerifyActivity(context.Background())
	assert.True(t, chk.Intact)
}

func TestTheChainShowsAnEditARemovalAndRowsCutOffTheEnd(t *testing.T) {
	for name, tamper := range map[string]struct {
		sql    string
		reason string
	}{
		"edit":        {`UPDATE operator_actions SET action = 'deny' WHERE id = 2`, "edited"},
		"edit a note": {`UPDATE operator_actions SET note = 'x' WHERE id = 3`, "edited"},
		"remove":      {`DELETE FROM operator_actions WHERE id = 2`, "removed"},
		"cut the end": {`DELETE FROM operator_actions WHERE id = 4`, "cut_off"},
		"cut all":     {`DELETE FROM operator_actions`, "cut_off"},
	} {
		t.Run(name, func(t *testing.T) {
			s := activityStore(t)
			ctx := context.Background()
			for i := 0; i < 4; i++ {
				require.NoError(t, s.RecordActivity(ctx, opMeta, ActApprove, "file", hexN(i), hexN(i), "team-a"))
			}
			chk, err := s.VerifyActivity(ctx)
			require.NoError(t, err)
			require.True(t, chk.Intact, "%+v", chk)
			require.Equal(t, 4, chk.Rows)
			_, err = s.db.ExecContext(ctx, tamper.sql)
			require.NoError(t, err)
			chk, err = s.VerifyActivity(ctx)
			require.NoError(t, err)
			assert.False(t, chk.Intact)
			assert.Equal(t, tamper.reason, chk.Reason)
		})
	}
}

func TestATrimRemovesOnlyTheOldestAndTheRestStillVerifies(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		require.NoError(t, s.RecordActivity(ctx, opMeta, ActApprove, "file", hexN(i), hexN(i), "team-a"))
	}
	// the first two are old
	_, err := s.db.ExecContext(ctx, `UPDATE operator_actions SET at = ? WHERE id <= 2`, time.Now().Add(-ActivityMaxAge-time.Hour).UTC().Format(time.RFC3339))
	require.NoError(t, err)
	// that edit is itself a change outside Coral: the record is not intact until the oldest rows are gone
	n, err := s.TrimActivity(ctx, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 2, n, "the count of rows that went")
	rows, _ := s.ListActivity(ctx, ActivityFilter{Limit: 10})
	assert.Len(t, rows, 3)
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the oldest kept row anchors the chain: %+v", chk)
	// the head is untouched: one more row chains on
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActDeny, "file", hexN(7), hexN(7), "team-a"))
	chk, _ = s.VerifyActivity(ctx)
	assert.True(t, chk.Intact)
}

func TestTheRecordNeverTakesAnActorOrSourceFromAnythingButItsMetaAndCleansItsText(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	long := strings.Repeat("é", 300)
	require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "hub:abc", Source: "hub", Hint: "<script>", Note: "ok​‮done\x07 " + long, Title: long}, ActDeny, "file", hexN(1), hexN(1), "team-a"))
	require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Source: "somewhere", Hint: "phone"}, ActSave, "file", hexN(2), hexN(2), "team-a"))
	rows, _ := s.ListActivity(ctx, ActivityFilter{})
	require.Len(t, rows, 2)
	assert.Equal(t, "local", rows[0].Source, "a source that is not local or hub is local")
	assert.Equal(t, "local", rows[0].Actor)
	assert.Equal(t, "phone", rows[0].Hint)
	assert.Equal(t, "hub", rows[1].Source)
	assert.Equal(t, "hub:abc", rows[1].Actor)
	assert.Empty(t, rows[1].Hint, "a hint that is not 'phone' is nothing")
	assert.Len(t, []rune(rows[1].Note), ActivityNoteCap)
	assert.True(t, strings.HasPrefix(rows[1].Note, "okdone "), rows[1].Note)
	assert.Len(t, []rune(rows[1].Title), activityTextCap)
}

func TestConcurrentActionsKeepOneUnbrokenChain(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), opMeta)
	done := make(chan error, 12)
	for i := 0; i < 12; i++ {
		go func(i int) {
			hex := hexN(i)
			if err := s.SetArtifactTags(context.Background(), fmt.Sprintf("team-%d", i), hex, []string{"for review"}); err != nil {
				done <- err
				return
			}
			_, _, err := s.DecideArtifactReview(ctx, fmt.Sprintf("team-%d", i), hex, ReviewApproved, time.Now())
			done <- err
		}(i)
	}
	for i := 0; i < 12; i++ {
		require.NoError(t, <-done)
	}
	chk, err := s.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.True(t, chk.Intact, "%+v", chk)
	assert.Equal(t, 12, chk.Rows)
}

// Security's early read of f18f7eedf (#12069).

func TestRowsCutOffTheFrontShowAsRemovedButATrimDoesNot(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		require.NoError(t, s.RecordActivity(ctx, opMeta, ActApprove, "file", hexN(i), hexN(i), "team-a"))
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM operator_actions WHERE id <= 2`) // a program removes the oldest two: every remaining link is still whole
	require.NoError(t, err)
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "the oldest kept row is not the anchor")
	assert.Equal(t, "removed", chk.Reason)
	assert.Equal(t, int64(3), chk.FirstBad)
}

func TestATrimThatRemovesEverythingLeavesAnIntactRecordThatGoesOn(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		require.NoError(t, s.RecordActivity(ctx, opMeta, ActApprove, "file", hexN(i), hexN(i), "team-a"))
	}
	_, err := s.db.ExecContext(ctx, `UPDATE operator_actions SET at = ?`, time.Now().Add(-ActivityMaxAge-time.Hour).UTC().Format(time.RFC3339))
	require.NoError(t, err)
	n, err := s.TrimActivity(ctx, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 3, n)
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "an empty record after a trim is not a cut: %+v", chk)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActDeny, "file", hexN(9), hexN(9), "team-a"))
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the next row chains on: %+v", chk)
	assert.Equal(t, 1, chk.Rows)
	// and deleting that row afterwards is a cut
	_, err = s.db.ExecContext(ctx, `DELETE FROM operator_actions`)
	require.NoError(t, err)
	chk, _ = s.VerifyActivity(ctx)
	assert.False(t, chk.Intact)
}

func TestTheCheckSaysWhatItCannotDo(t *testing.T) {
	s := activityStore(t)
	chk, err := s.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "Edits made outside Coral are shown unless the whole record was rewritten.", chk.Note)
	require.NoError(t, s.RecordActivity(context.Background(), opMeta, ActApprove, "file", hexN(1), hexN(1), "team-a"))
	_, _ = s.db.ExecContext(context.Background(), `UPDATE operator_actions SET action = 'deny'`)
	chk, _ = s.VerifyActivity(context.Background())
	assert.False(t, chk.Intact)
	assert.Equal(t, ActivityCheckNote, chk.Note, "a break carries it too")
}

func TestARowThatCannotBeCompletedLeavesNoRowAndTheDecisionStands(t *testing.T) {
	s := activityStore(t)
	ctx := WithActivity(context.Background(), opMeta)
	// the head can be read but not written: the row is inserted, then its head update fails
	_, err := s.db.ExecContext(ctx, `CREATE TRIGGER no_head_writes BEFORE INSERT ON operator_actions_head BEGIN SELECT RAISE(ABORT, 'head is read only'); END`)
	require.NoError(t, err)
	hex := hexN(4)
	s.forReview(t, "team-a", hex)
	_, _, err = s.DecideArtifactReview(ctx, "team-a", hex, ReviewApproved, time.Now())
	require.NoError(t, err, "a record that cannot be written never blocks the action")
	reviews, err := s.ArtifactReviews(context.Background(), "team-a")
	require.NoError(t, err)
	assert.Equal(t, ReviewApproved, reviews[hex].State, "the approval stands")
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM operator_actions`))
	assert.Zero(t, n, "the row went with the failed head: the pair is one step")
}

func TestEveryFormatSeparatorAndControlCharacterIsStrippedFromText(t *testing.T) {
	for name, r := range map[string]rune{"left-to-right mark": 0x200e, "right-to-left mark": 0x200f, "arabic letter mark": 0x061c, "line separator": 0x2028, "paragraph separator": 0x2029, "a tag character": 0xe0041, "zero-width space": 0x200b, "override": 0x202e, "bell": 0x07, "soft hyphen": 0xad} {
		assert.Equal(t, "ab", activityText("a"+string(r)+"b", 50), name)
	}
	assert.Equal(t, "a b", activityText("a \t\n  b", 50), "runs of space and line breaks are one space")
}

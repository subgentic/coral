package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11007: a write to a board (a message, a subscribe, a task) records the board's own row after the content. A DELETE of the board that landed between the two removed the content and the row, and the write's
// row came back after it: a board with 0 messages, 0 tasks and 0 subscribers that no list shows. The write and the row are one step now, so the delete comes before or after both, never between.
func TestDeletedBoardRowDoesNotComeBack(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	boardRows := func(key string) int {
		var n int
		require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM boards WHERE id = ?`, key))
		return n
	}
	// deleteDuringWrite deletes the board from another goroutine while the write is between its content and its board row, and waits for the delete a moment: a delete that can run now (the old code) has run
	// when the write goes on; one that has to wait for the write (the one-step code) runs right after it.
	deleteDuringWrite := func(key string) (deleted chan error) {
		deleted = make(chan error, 1)
		betweenContentAndBoardRow = func() {
			betweenContentAndBoardRow = nil
			go func() { deleted <- s.DeleteProject(ctx, key) }()
			time.Sleep(300 * time.Millisecond)
		}
		t.Cleanup(func() { betweenContentAndBoardRow = nil })
		return deleted
	}
	for _, tc := range []struct {
		name  string
		write func(key string) error
	}{
		{"a message", func(key string) error { _, err := s.PostMessage(ctx, key, "Lead", "hello", nil); return err }},
		{"a subscribe", func(key string) error { _, err := s.Subscribe(ctx, key, "Dev", "Dev", "", nil, "all"); return err }},
		{"a goal", func(key string) error {
			_, err := s.CreateGoal(ctx, key, GoalInput{Title: "a goal", Outcome: "o", DoneWhen: "d", CreatedBy: "Lead"})
			return err
		}},
		{"a task", func(key string) error { _, err := s.CreateTask(ctx, key, "a task", "", "medium", "Lead"); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := s.CreateBoard(ctx, "race-"+time.Now().Format("150405.000000"), "Operator")
			require.NoError(t, err)
			_, err = s.Subscribe(ctx, b.ID, "Lead", "Lead", "", nil, "all")
			require.NoError(t, err)
			deleted := deleteDuringWrite(b.ID)
			_ = tc.write(b.ID) // it may report the board gone (its read-back after the delete): the board and its content must be gone either way
			select {
			case err := <-deleted:
				require.NoError(t, err)
			case <-time.After(5 * time.Second):
				t.Fatal("the delete never finished")
			}
			assert.Equal(t, 0, boardRows(b.ID), "the board is gone after its delete, whichever step of the write it landed in")
			var rows int
			require.NoError(t, s.db.GetContext(ctx, &rows, `SELECT (SELECT COUNT(*) FROM board_messages WHERE project = ?) + (SELECT COUNT(*) FROM board_tasks WHERE board_id = ?) + (SELECT COUNT(*) FROM board_subscribers WHERE project = ?) + (SELECT COUNT(*) FROM board_goals WHERE board_id = ?)`, b.ID, b.ID, b.ID, b.ID))
			assert.Equal(t, 0, rows, "and nothing of it is left behind")
		})
	}
}

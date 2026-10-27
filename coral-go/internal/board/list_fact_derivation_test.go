package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The derivation version is the hash of what derives the columns. When the expressions, the column definitions or the triggers change, this fails until listFactDerivation is set to the new hash, which is what makes
// the next open derive every row again (#9610).
func TestListFactDerivationIsPinned(t *testing.T) {
	assert.Equal(t, listFactDerivationOf(), listFactDerivation, "the list facts' derivation changed: set listFactDerivation to this hash, so existing rows are derived again at the next open")
}

func listFactOpen(t *testing.T, path string) *Store {
	t.Helper()
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	return s
}

func outcomeOf(t *testing.T, s *Store, id int64) string {
	t.Helper()
	var v string
	require.NoError(t, s.db.GetContext(context.Background(), &v, `SELECT lst_outcome FROM task_workflows WHERE task_id = ?`, id))
	return v
}

// The full check runs when the stored derivation is not the code's, when a trigger is missing (an older binary wrote with none) or when a row has no facts yet; any other open leaves the rows alone (#9610).
func TestListFactCheckRunsOnlyWhenSomethingCouldBeWrong(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board.db")
	s := listFactOpen(t, path)
	var ids []int64
	for i := 0; i < 3; i++ {
		c, err := s.CreateTaskWithOpts(ctx, "alpha", fmt.Sprintf("t%d", i), "", "medium", "Orch", nil, "Dev")
		require.NoError(t, err)
		require.NoError(t, saveWorkflow(ctx, s.db, c.ID, TaskWorkflow{Instructions: DefaultTaskWorkflowInstructions, Outcome: "success"}))
		ids = append(ids, c.ID)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		_, err := s.db.ExecContext(ctx, q, args...)
		require.NoError(t, err, q)
	}
	reopen := func() {
		t.Helper()
		require.NoError(t, s.Close())
		s = listFactOpen(t, path)
	}
	require.Equal(t, "success", outcomeOf(t, s, ids[0]))

	// 1. same derivation, triggers present, every row derived: a column edited behind the triggers' back is not looked at (the open costs three reads, not a pass over the documents)
	exec(`UPDATE task_workflows SET lst_outcome = 'edited' WHERE task_id = ?`, ids[0])
	reopen()
	assert.Equal(t, "edited", outcomeOf(t, s, ids[0]), "the cheap open does not re-derive")

	// 2. a changed derivation (a stored version that is not the code's): everything is checked and repaired
	exec(`UPDATE board_derivations SET version = 'older' WHERE name = 'task_workflows_list_facts'`)
	reopen()
	assert.Equal(t, "success", outcomeOf(t, s, ids[0]), "a version change re-derives")
	var v string
	require.NoError(t, s.db.GetContext(ctx, &v, `SELECT version FROM board_derivations WHERE name = 'task_workflows_list_facts'`))
	assert.Equal(t, listFactDerivation, v)

	// 3. an older binary's write: no triggers in its database, so the document changes and the columns do not; the next open sees the missing trigger and repairs
	exec(`DROP TRIGGER task_workflows_lst_au`)
	exec(`UPDATE task_workflows SET data = replace(data, '"outcome":"success"', '"outcome":"failed"') WHERE task_id = ?`, ids[1])
	assert.Equal(t, "success", outcomeOf(t, s, ids[1]), "no trigger, so the column is behind")
	reopen()
	assert.Equal(t, "failed", outcomeOf(t, s, ids[1]), "a missing trigger re-derives")
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (`+listFactTriggerNames+`)`))
	assert.Equal(t, 2, n, "and the trigger is back")

	// 4. a changed derivation replaces the old triggers too: with a trigger of an older body left in place, every later write would be derived by the old expression
	exec(`DROP TRIGGER task_workflows_lst_au`)
	exec(`DROP TRIGGER task_workflows_lst_ai`)
	exec(`CREATE TRIGGER task_workflows_lst_ai AFTER INSERT ON task_workflows BEGIN UPDATE task_workflows SET lst_outcome = 'stale-insert' WHERE task_id = NEW.task_id; END`)
	exec(`CREATE TRIGGER task_workflows_lst_au AFTER UPDATE OF data ON task_workflows BEGIN UPDATE task_workflows SET lst_outcome = 'stale-update' WHERE task_id = NEW.task_id; END`)
	exec(`UPDATE board_derivations SET version = 'older' WHERE name = 'task_workflows_list_facts'`)
	reopen()
	require.NoError(t, saveWorkflow(ctx, s.db, ids[0], TaskWorkflow{Instructions: DefaultTaskWorkflowInstructions, Outcome: "after"}))
	assert.Equal(t, "after", outcomeOf(t, s, ids[0]), "a write after the change is derived by the new expression, not the old trigger's")
	c, err := s.CreateTaskWithOpts(ctx, "alpha", "fresh", "", "medium", "Orch", nil, "Dev")
	require.NoError(t, err)
	require.NoError(t, saveWorkflow(ctx, s.db, c.ID, TaskWorkflow{Instructions: DefaultTaskWorkflowInstructions, Outcome: "inserted"}))
	assert.Equal(t, "inserted", outcomeOf(t, s, c.ID), "and so is an insert")

	// 5. a row with no facts yet is derived
	exec(`UPDATE task_workflows SET lst_state = 0, lst_outcome = 'x' WHERE task_id = ?`, ids[2])
	reopen()
	assert.Equal(t, "success", outcomeOf(t, s, ids[2]))
	require.NoError(t, s.Close())
}

package store_test

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The columns of workflows in v2.1.16. A Coral of that version reads the table with SELECT * into a struct and refuses a column it does not know, so going back a version would break the Automations list: a new
// piece of workflow state is a table of its own (workflow_boards), never a column of workflows. Adding a column here is the thing this test stops.
var workflowColumnsV2116 = []string{"base_branch", "cleanup_worktree", "created_at", "default_agent_json", "description", "enabled", "id", "max_duration_s", "name", "repo_path", "steps_json", "updated_at"}

type workflowRowV2116 struct {
	ID               int64  `db:"id"`
	Name             string `db:"name"`
	Description      string `db:"description"`
	StepsJSON        string `db:"steps_json"`
	DefaultAgentJSON string `db:"default_agent_json"`
	RepoPath         string `db:"repo_path"`
	BaseBranch       string `db:"base_branch"`
	MaxDurationS     int    `db:"max_duration_s"`
	CleanupWorktree  int    `db:"cleanup_worktree"`
	Enabled          int    `db:"enabled"`
	CreatedAt        string `db:"created_at"`
	UpdatedAt        string `db:"updated_at"`
}

func TestTheWorkflowsTableKeepsTheColumnsOfTheLastRelease(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	var cols []string
	rows, err := db.QueryxContext(ctx, `SELECT name FROM pragma_table_info('workflows')`)
	require.NoError(t, err)
	for rows.Next() {
		var n string
		require.NoError(t, rows.Scan(&n))
		cols = append(cols, n)
	}
	require.NoError(t, rows.Close())
	sort.Strings(cols)
	assert.Equal(t, workflowColumnsV2116, cols, "workflows gained a column: an older Coral's Automations list would fail on it")

	// and the old build's own scan works on a workflow that has a team set
	ws := store.NewWorkflowStore(db)
	w, err := ws.CreateWorkflow(ctx, &store.Workflow{Name: "alerts", StepsJSON: "[]", Enabled: 1, Board: "ops"})
	require.NoError(t, err)
	var old []workflowRowV2116
	require.NoError(t, db.SelectContext(ctx, &old, `SELECT * FROM workflows`), "the v2.1.16 scan of the table")
	require.Len(t, old, 1)
	assert.Equal(t, "alerts", old[0].Name)
	got, err := ws.GetWorkflow(ctx, w.ID)
	require.NoError(t, err)
	assert.Equal(t, "ops", got.Board)
}

// A data folder that was last opened by v2.1.16 has no workflow_boards table: opening it adds the table, keeps every workflow, and the team can be set and read; deleting the workflow takes its row.
func TestADataFolderOfTheLastReleaseUpgradesAndKeepsItsWorkflows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "s.db")
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	ws := store.NewWorkflowStore(db)
	w, err := ws.CreateWorkflow(ctx, &store.Workflow{Name: "alerts", StepsJSON: `[{"name":"a","type":"shell","command":"true"}]`, Enabled: 1})
	require.NoError(t, err)
	// shape it as v2.1.16 left it: none of the tables this release added
	for _, tbl := range []string{"workflow_boards", "automation_tokens", "automation_writes"} {
		_, err := db.ExecContext(ctx, `DROP TABLE IF EXISTS `+tbl)
		require.NoError(t, err)
	}
	require.NoError(t, db.Close())

	db, err = storetest.Open(t, path)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ws = store.NewWorkflowStore(db)
	got, err := ws.GetWorkflow(ctx, w.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "alerts", got.Name)
	assert.Equal(t, "", got.Board)
	_, err = ws.UpdateWorkflow(ctx, w.ID, map[string]interface{}{"board": "ops"})
	require.NoError(t, err)
	got, _ = ws.GetWorkflow(ctx, w.ID)
	assert.Equal(t, "ops", got.Board)
	list, err := ws.ListWorkflows(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "ops", list[0].Board)
	byName, _ := ws.GetWorkflowByName(ctx, "alerts")
	assert.Equal(t, "ops", byName.Board)
	_, err = ws.UpdateWorkflow(ctx, w.ID, map[string]interface{}{"board": ""})
	require.NoError(t, err)
	got, _ = ws.GetWorkflow(ctx, w.ID)
	assert.Equal(t, "", got.Board, "an empty team removes the row")

	_, err = ws.UpdateWorkflow(ctx, w.ID, map[string]interface{}{"board": "ops"})
	require.NoError(t, err)
	require.NoError(t, ws.DeleteWorkflow(ctx, w.ID))
	var n int
	require.NoError(t, db.GetContext(ctx, &n, `SELECT COUNT(*) FROM workflow_boards`))
	assert.Zero(t, n, "the row goes with the workflow")
	assert.False(t, strings.Contains(strings.Join(workflowColumnsV2116, ","), "board"))
}

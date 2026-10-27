package board

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// The task list (GET /api/board/{b}/tasks) reads eight facts of each task's workflow: its outcome, who did the work, whether a review was requested, the reviewers of the newest round, the review's areas, whether it
// waits in the pool, how many reviewers it wants and how many distinct artifacts its results hold. It took them with json_extract and json_each over the stored document, which SQLite parses again for every
// one: about 2 ms of the 4 ms the row query took for a page of 200 open tasks, and the artifact count read every document a second time (#9554, #9556). They are columns of task_workflows now (lst_*), and the
// list reads columns only.
//
// The columns are derived data, kept in step by triggers on task_workflows (so any writer of any version leaves them right, as board_message_counts does, #9503), and every open re-derives the rows that
// have none yet and repairs and logs the rows whose columns disagree with their document, so a drift cannot last past a restart. lst_state is 0 for a row not derived yet and 1 once it is; a document that is
// not valid JSON is derived as the defaults (the list used to fail on it).

// listFactCols are the columns, with their definitions and the default of a document that is not valid JSON.
var listFactCols = []struct{ name, def, none string }{
	{"lst_outcome", "TEXT NOT NULL DEFAULT ''", "''"},
	{"lst_author", "TEXT NOT NULL DEFAULT ''", "''"},
	{"lst_review_requested", "INTEGER NOT NULL DEFAULT 0", "0"},
	{"lst_reviewers", "TEXT NOT NULL DEFAULT '[]'", "'[]'"},
	{"lst_review_areas", "TEXT NOT NULL DEFAULT '[]'", "'[]'"},
	{"lst_in_pool", "INTEGER NOT NULL DEFAULT 0", "0"},
	{"lst_wanted", "INTEGER NOT NULL DEFAULT 0", "0"},
	{"lst_artifacts", "INTEGER NOT NULL DEFAULT 0", "0"},
}

// listFactExprs are the expressions of the columns over a document d (a column or NEW.data), in listFactCols order. The artifact count is the distinct stored objects and links of the completion's and the
// review's artifacts, each once, and a piece of inline content once for its place (countDistinctArtifacts, the Go twin the oracle test compares it with).
func listFactExprs(d string) []string {
	uris := `(SELECT COUNT(DISTINCT u) FROM (SELECT json_extract(a.value, '$.uri') AS u FROM json_each(` + d + `, '$.artifacts') a UNION ALL SELECT json_extract(a.value, '$.uri') FROM json_each(` + d + `, '$.completion_review.artifacts') a) WHERE COALESCE(u, '') != '')`
	inline := func(path string) string {
		return `(SELECT COUNT(*) FROM json_each(` + d + `, '` + path + `') a WHERE COALESCE(json_extract(a.value, '$.uri'), '') = '' AND COALESCE(json_extract(a.value, '$.content'), '') != '')`
	}
	return []string{
		`COALESCE(json_extract(` + d + `, '$.outcome'), '')`,
		`COALESCE(json_extract(` + d + `, '$.original_author'), '')`,
		`COALESCE(json_type(` + d + `, '$.completion_review') = 'object', 0)`,
		`COALESCE((SELECT json_group_array(json_extract(v.value, '$.reviewer')) FROM json_each(` + d + `, '$.review_rounds[#-1].reviewers') v WHERE v.type = 'object'), '[]')`,
		`COALESCE(json_extract(` + d + `, '$.review_areas'), '[]')`,
		`CASE WHEN COALESCE(json_extract(` + d + `, '$.review_in_pool'), 0) = 1 THEN 1 ELSE 0 END`,
		`COALESCE(json_extract(` + d + `, '$.reviewers_wanted'), 0)`,
		`CASE WHEN ` + d + ` LIKE '%` + artifactsMark + `%' THEN ` + uris + ` + ` + inline("$.artifacts") + ` + ` + inline("$.completion_review.artifacts") + ` ELSE 0 END`, // a document without the mark (most tasks) holds no artifact row: the text test is cheaper than the two walks (the same mark has_artifacts uses)
	}
}

// listFactAssign is "lst_outcome = <expr>, ..., lst_state = 1" over d, each expression guarded by json_valid(d) so an invalid document is the defaults.
func listFactAssign(d string) string {
	exprs := listFactExprs(d)
	parts := make([]string, 0, len(exprs)+1)
	for i, c := range listFactCols {
		parts = append(parts, fmt.Sprintf("%s = CASE WHEN json_valid(%s) THEN %s ELSE %s END", c.name, d, exprs[i], c.none))
	}
	return strings.Join(parts, ", ") + ", lst_state = 1"
}

// listFactDiffers is true for a row whose columns are not what its document says (or that has none yet).
func listFactDiffers() string {
	exprs := listFactExprs("data")
	parts := []string{"lst_state = 0"}
	for i, c := range listFactCols {
		parts = append(parts, fmt.Sprintf("%s IS NOT CASE WHEN json_valid(data) THEN %s ELSE %s END", c.name, exprs[i], c.none))
	}
	return strings.Join(parts, " OR ")
}

// ensureWorkflowListFacts adds the columns and the triggers, derives the rows that have none yet and re-derives (and logs) the rows that disagree with their document: one pass over the stored documents at
// every open, in one transaction, so no write lands between the check and the triggers being in place.
func (s *Store) ensureWorkflowListFacts(ctx context.Context) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	cols := append([]struct{ name, def, none string }{{"lst_state", "INTEGER NOT NULL DEFAULT 0", "0"}}, listFactCols...)
	for _, c := range cols {
		var n int
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM pragma_table_info('task_workflows') WHERE name = ?`, c.name); err != nil {
			return err
		}
		if n == 0 {
			if _, err := tx.ExecContext(ctx, `ALTER TABLE task_workflows ADD COLUMN `+c.name+` `+c.def); err != nil {
				return err
			}
		}
	}
	var fresh int
	if err := tx.GetContext(ctx, &fresh, `SELECT COUNT(*) FROM task_workflows WHERE lst_state = 0`); err != nil {
		return err
	}
	if fresh > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE task_workflows SET `+listFactAssign("data")+` WHERE lst_state = 0`); err != nil {
			return err
		}
	}
	res, err := tx.ExecContext(ctx, `UPDATE task_workflows SET `+listFactAssign("data")+` WHERE `+listFactDiffers())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("board: re-derived the task list facts of %d task workflow(s): they did not match the stored documents", n)
	}
	for _, t := range []struct{ name, event string }{{"task_workflows_lst_ai", "AFTER INSERT ON task_workflows"}, {"task_workflows_lst_au", "AFTER UPDATE OF data ON task_workflows"}} {
		if _, err := tx.ExecContext(ctx, `CREATE TRIGGER IF NOT EXISTS `+t.name+` `+t.event+` BEGIN UPDATE task_workflows SET `+listFactAssign("NEW.data")+` WHERE task_id = NEW.task_id; END`); err != nil {
			return err
		}
	}
	return tx.Commit()
}

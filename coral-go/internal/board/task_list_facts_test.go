package board

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// #9556 (Goal #102): the workflow facts the task list reads are columns of task_workflows (task_list_facts.go). The list must say exactly what it said when it read the document: these tests compare it with the
// document's own decode (decodeWorkflow, countDistinctArtifacts), for writers of every kind.

func factsStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_facts.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func rounds(names ...[]string) []ReviewRound {
	var out []ReviewRound
	for i, ns := range names {
		r := ReviewRound{Round: i + 1}
		for _, n := range ns {
			r.Reviewers = append(r.Reviewers, ReviewerState{Reviewer: n})
		}
		out = append(out, r)
	}
	return out
}

// factsWorkflows are workflows with every shape the facts have an edge in.
func factsWorkflows() map[string]TaskWorkflow {
	u1, u2 := "coral://artifacts/"+strings.Repeat("a", 64), "coral://artifacts/"+strings.Repeat("b", 64)
	return map[string]TaskWorkflow{
		"empty":            {},
		"outcome only":     {Outcome: "Fixed the bug"},
		"author":           {OriginalAuthor: "Backend Dev", Outcome: "x"},
		"one uri":          {Artifacts: []TaskArtifact{{Name: "patch", URI: u1}}},
		"same uri twice":   {Artifacts: []TaskArtifact{{Name: "a", URI: u1}, {Name: "b", URI: u1}}, CompletionReview: &CompletionReview{Artifacts: []TaskArtifact{{Name: "c", URI: u1}, {Name: "d", URI: u2}}}},
		"inline twice":     {Artifacts: []TaskArtifact{{Name: "n", Content: "text"}, {Name: "m", Content: "more"}}, CompletionReview: &CompletionReview{Artifacts: []TaskArtifact{{Name: "n", Content: "text"}}}},
		"empty rows":       {Artifacts: []TaskArtifact{{Name: "none"}}, CompletionReview: &CompletionReview{}},
		"uri beats inline": {Artifacts: []TaskArtifact{{Name: "x", URI: u2, Content: "text"}}},
		"two rounds":       {ReviewRounds: rounds([]string{"QA Engineer"}, []string{"Security Reviewer", "QA Reviewer 2"}), ReviewAreas: []string{"frontend", "perf"}, ReviewersWanted: 2, ReviewInPool: true, CompletionReview: &CompletionReview{}},
		"round no names":   {ReviewRounds: []ReviewRound{{Round: 1}}},
		"pool, one":        {ReviewInPool: true, ReviewAreas: []string{"go"}},
	}
}

// expectedFacts is what the list used to read from the decoded document.
func expectedFacts(t *testing.T, w TaskWorkflow, raw string, status string) TaskListItem {
	t.Helper()
	d, err := decodeWorkflow(raw, true)
	if err != nil {
		t.Fatal(err)
	}
	var it TaskListItem
	it.Outcome, it.ReviewRequested = d.Outcome, d.CompletionReview != nil
	if n := len(d.ReviewRounds); n > 0 {
		for _, r := range d.ReviewRounds[n-1].Reviewers {
			it.Reviewers = append(it.Reviewers, r.Reviewer)
		}
	}
	it.ReviewAreas, it.ReviewersWanted = d.ReviewAreas, d.ReviewersWanted
	it.ReviewInPool = status == "review_pending" && d.ReviewInPool
	it.ArtifactCount = countDistinctArtifacts(&d)
	return it
}

func TestListFactsEqualTheDocumentRead(t *testing.T) {
	s := factsStore(t)
	ctx := context.Background()
	ids := map[string]int64{}
	for name, w := range factsWorkflows() {
		task, err := s.CreateTask(ctx, "team", name, "body", "medium", "Orchestrator")
		if err != nil {
			t.Fatal(err)
		}
		if err := saveWorkflow(ctx, s.db, task.ID, w); err != nil {
			t.Fatal(err)
		}
		if w.ReviewInPool {
			if _, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'review_pending' WHERE id = ?`, task.ID); err != nil {
				t.Fatal(err)
			}
		}
		ids[name] = task.ID
	}
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: TaskListAll, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Tasks) != len(ids) {
		t.Fatalf("%d tasks listed, %d made", len(page.Tasks), len(ids))
	}
	byID := map[int64]TaskListItem{}
	for _, it := range page.Tasks {
		byID[it.ID] = it
	}
	for name, id := range ids {
		var raw string
		if err := s.db.Get(&raw, `SELECT data FROM task_workflows WHERE task_id = ?`, id); err != nil {
			t.Fatal(err)
		}
		got, want := byID[id], expectedFacts(t, factsWorkflows()[name], raw, byID[id].Status)
		if got.Outcome != want.Outcome || got.ReviewRequested != want.ReviewRequested || got.ReviewInPool != want.ReviewInPool || got.ReviewersWanted != want.ReviewersWanted ||
			got.ArtifactCount != want.ArtifactCount || !reflect.DeepEqual(got.Reviewers, want.Reviewers) || !reflect.DeepEqual(got.ReviewAreas, want.ReviewAreas) {
			t.Errorf("%s: the list says %+v, the document says %+v", name, got, want)
		}
	}
	if got := byID[ids["same uri twice"]].ArtifactCount; got != 2 {
		t.Errorf("a link listed three times and another once is 2 artifacts, got %d", got)
	}
	if got := byID[ids["inline twice"]].ArtifactCount; got != 3 {
		t.Errorf("inline content counts once for its place (3), got %d", got)
	}
	if got := byID[ids["author"]].WorkedBy; got != "Backend Dev" {
		t.Errorf("worked_by is the original author, got %q", got)
	}
}

// An older Coral writes task_workflows without knowing the lst_ columns, by INSERT or by UPDATE of the document: the triggers keep them right for any writer.
func TestListFactsFollowAnOlderWritersInsertAndUpdate(t *testing.T) {
	s := factsStore(t)
	ctx := context.Background()
	task, _ := s.CreateTask(ctx, "team", "t", "b", "medium", "Orchestrator")
	doc := func(outcome string) string {
		return fmt.Sprintf(`{"instructions":"x","outcome":%q,"artifacts":[{"name":"p","uri":"coral://artifacts/%s"}],"review_rounds":[{"round":1,"reviewers":[{"reviewer":"QA Engineer"}]}]}`, outcome, strings.Repeat("c", 64))
	}
	check := func(want string) {
		t.Helper()
		var row struct {
			Outcome   string `db:"lst_outcome"`
			Artifacts int    `db:"lst_artifacts"`
			Reviewers string `db:"lst_reviewers"`
			State     int    `db:"lst_state"`
		}
		if err := s.db.Get(&row, `SELECT lst_outcome, lst_artifacts, lst_reviewers, lst_state FROM task_workflows WHERE task_id = ?`, task.ID); err != nil {
			t.Fatal(err)
		}
		if row.Outcome != want || row.Artifacts != 1 || row.Reviewers != `["QA Engineer"]` || row.State != 1 {
			t.Errorf("columns %+v, want outcome %q, 1 artifact, QA Engineer, derived", row, want)
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO task_workflows(task_id, data) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data`, task.ID, doc("first")); err != nil {
		t.Fatal(err)
	}
	check("first")
	if _, err := s.db.ExecContext(ctx, `INSERT INTO task_workflows(task_id, data) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data`, task.ID, doc("second")); err != nil {
		t.Fatal(err)
	}
	check("second")
	if _, err := s.db.ExecContext(ctx, `UPDATE task_workflows SET data = ? WHERE task_id = ?`, doc("third"), task.ID); err != nil {
		t.Fatal(err)
	}
	check("third")
}

// A document that is not valid JSON is the defaults (the list used to fail on it), and the rest of the page is whole.
func TestListFactsOfAnInvalidDocumentAreTheDefaults(t *testing.T) {
	s := factsStore(t)
	ctx := context.Background()
	bad, _ := s.CreateTask(ctx, "team", "bad", "b", "medium", "Orchestrator")
	good, _ := s.CreateTask(ctx, "team", "good", "b", "medium", "Orchestrator")
	if err := saveWorkflow(ctx, s.db, good.ID, TaskWorkflow{Outcome: "fine"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO task_workflows(task_id, data) VALUES (?, '{not json') ON CONFLICT(task_id) DO UPDATE SET data = excluded.data`, bad.ID); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: TaskListAll})
	if err != nil {
		t.Fatalf("one bad document must not fail the list: %v", err)
	}
	for _, it := range page.Tasks {
		if it.ID == bad.ID && (it.Outcome != "" || it.ArtifactCount != 0 || it.Reviewers != nil) {
			t.Errorf("the bad document's row: %+v", it)
		}
		if it.ID == good.ID && it.Outcome != "fine" {
			t.Errorf("the good row: %+v", it)
		}
	}
}

// Opening re-derives a row whose columns disagree with its document (a writer that bypassed the triggers, a trigger dropped) and says how many; rows never derived are derived without a word.
func TestListFactsReopenRepairsAndLogsADifference(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board_facts_reopen.db")
	s, err := NewStoreWithKey(path, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	a, _ := s.CreateTask(ctx, "team", "a", "b", "medium", "Orchestrator")
	b, _ := s.CreateTask(ctx, "team", "b", "b", "medium", "Orchestrator")
	c, _ := s.CreateTask(ctx, "team", "c", "b", "medium", "Orchestrator")
	for _, id := range []int64{a.ID, b.ID, c.ID} {
		if err := saveWorkflow(ctx, s.db, id, TaskWorkflow{Outcome: "right", Artifacts: []TaskArtifact{{Name: "p", URI: "coral://artifacts/" + strings.Repeat("d", 64)}}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		`DROP TRIGGER task_workflows_lst_au`, // an older writer that does not have the trigger
		fmt.Sprintf(`UPDATE task_workflows SET data = replace(data, 'right', 'newer') WHERE task_id = %d`, a.ID),
		fmt.Sprintf(`UPDATE task_workflows SET lst_artifacts = 7 WHERE task_id = %d`, b.ID),
		fmt.Sprintf(`UPDATE task_workflows SET lst_state = 0 WHERE task_id = %d`, c.ID), // never derived: no log
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	s, err = NewStoreWithKey(path, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if !strings.Contains(logged.String(), "re-derived the task list facts of 2 task workflow(s)") {
		t.Errorf("two rows differed (a's outcome, b's count) and c was never derived: log was %q", logged.String())
	}
	var rows []struct {
		ID      int64  `db:"task_id"`
		Outcome string `db:"lst_outcome"`
		N       int    `db:"lst_artifacts"`
	}
	if err := s.db.Select(&rows, `SELECT task_id, lst_outcome, lst_artifacts FROM task_workflows ORDER BY task_id`); err != nil {
		t.Fatal(err)
	}
	want := map[int64]string{a.ID: "newer", b.ID: "right", c.ID: "right"}
	for _, r := range rows {
		if r.Outcome != want[r.ID] || r.N != 1 {
			t.Errorf("task %d after the reopen: outcome %q, %d artifacts", r.ID, r.Outcome, r.N)
		}
	}
	logged.Reset()
	s.Close()
	if s, err = NewStoreWithKey(path, ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logged.String(), "re-derived") {
		t.Errorf("a store whose columns are right says nothing: %q", logged.String())
	}
}

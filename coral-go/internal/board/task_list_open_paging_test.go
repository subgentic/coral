package board

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9121 (Goal #85): the default list pages a big open set. A board whose open tasks fit the page is read as it always was (every open task, then the first page of done tasks); a bigger one comes `limit` open tasks at a
// time in priority order, its cursor continues them, the page that ends them is followed by the first done page, and the totals are exact on every page.
func TestDefaultTaskListPagesTheOpenSet(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_paging.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	seedTaskBoard(t, s, 130, 60) // ids 1..130 open (medium), 131..190 done
	for _, p := range []struct {
		id       int64
		priority string
	}{{120, "critical"}, {121, "critical"}, {5, "high"}, {125, "low"}, {126, "low"}} {
		_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET priority = ? WHERE id = ?`, p.priority, p.id)
		require.NoError(t, err)
	}

	first, err := s.ListTaskPage(ctx, "team", TaskListQuery{Limit: 50})
	require.NoError(t, err)
	require.Len(t, first.Tasks, 50, "the first page is 50 open tasks, not the 130")
	assert.NotEmpty(t, first.NextCursor, "and its cursor continues the open set")
	assert.Equal(t, []int64{120, 121, 5}, []int64{first.Tasks[0].ID, first.Tasks[1].ID, first.Tasks[2].ID}, "critical first, then high, then medium by id")
	assert.Equal(t, 130, first.TotalOpen)
	assert.Equal(t, 60, first.TotalCompleted)

	seen := map[int64]bool{}
	var open, done int
	page := first
	pages := 0
	for {
		pages++
		assert.Equal(t, 130, page.TotalOpen, "the totals are exact on page %d", pages)
		assert.Equal(t, 60, page.TotalCompleted)
		for _, it := range page.Tasks {
			assert.False(t, seen[it.ID], "task %d appears once", it.ID)
			seen[it.ID] = true
			if it.Status == "completed" {
				done++
			} else {
				open++
			}
		}
		if page.NextCursor == "" {
			break
		}
		page, err = s.ListTaskPage(ctx, "team", TaskListQuery{Limit: 50, Cursor: page.NextCursor})
		require.NoError(t, err)
		require.Less(t, pages, 10, "the cursor ends")
	}
	assert.Equal(t, 130, open, "every open task is on some page")
	assert.Equal(t, 60, done, "then every done task")
	assert.Equal(t, 4, pages, "50 open, 50 open, 30 open with the first 50 done, 10 done")

	// A small open set is read whole, with the first page of done tasks, as before.
	small, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_small.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { small.Close() })
	seedTaskBoard(t, small, 12, 70)
	p, err := small.ListTaskPage(ctx, "team", TaskListQuery{Limit: 50})
	require.NoError(t, err)
	assert.Len(t, p.Tasks, 62, "12 open and 50 done")
	assert.NotEmpty(t, p.NextCursor, "the cursor continues the done tasks")
	next, err := small.ListTaskPage(ctx, "team", TaskListQuery{Limit: 50, Cursor: p.NextCursor})
	require.NoError(t, err)
	assert.Len(t, next.Tasks, 20)

	// A cursor from another board or a made-up one is refused.
	_, err = s.ListTaskPage(ctx, "team", TaskListQuery{Cursor: "bogus"})
	assert.ErrorIs(t, err, ErrBadTaskListQuery)
}

// The size of a poll: a board with 1,500 open tasks answers the default list with one page of rows instead of all of them (the Tasks tab polls it every 10 s).
func TestDefaultTaskListPageSizeOnABigOpenSet(t *testing.T) {
	ctx := context.Background()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_size.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	seedTaskBoard(t, s, 1500, 100)
	page, err := s.ListTaskPage(ctx, "team", TaskListQuery{})
	require.NoError(t, err)
	body, err := json.Marshal(page)
	require.NoError(t, err)
	var all []TaskListItem
	cursor := ""
	for {
		p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Status: TaskListOpen, Limit: TaskListMaxLimit, Cursor: cursor})
		require.NoError(t, err)
		all = append(all, p.Tasks...)
		if cursor = p.NextCursor; cursor == "" {
			break
		}
	}
	full, err := json.Marshal(all)
	require.NoError(t, err)
	t.Logf("default list page: %d rows, %d bytes; the 1,500 open tasks: %d bytes", len(page.Tasks), len(body), len(full))
	assert.Len(t, page.Tasks, 50)
	assert.Less(t, len(body)*20, len(full), "a poll costs a small part of the whole open set")
}

// The page boundary (the review of #9121): a board with exactly `limit` open tasks gets them and the first page of done tasks, as it always did; one more open task makes the page the first `limit` open tasks and a cursor, with
// no done task in it. A mutant that treats "limit rows" as "more to come" fails the first case.
func TestDefaultTaskListPageBoundaries(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		name         string
		open, done   int
		limit        int
		wantRows     int
		wantDoneRows int
		wantCursor   bool
	}{
		{"one under the limit", 49, 20, 50, 69, 20, false},
		{"exactly the limit", 50, 20, 50, 70, 20, false},
		{"one over the limit", 51, 20, 50, 50, 0, true},
		{"exactly the limit with more done than a page", 50, 60, 50, 100, 50, true},
		{"limit 1, one open task", 1, 2, 1, 2, 1, true},
		{"limit 1, two open tasks", 2, 2, 1, 1, 0, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board_boundary.db"), "")
			require.NoError(t, err)
			t.Cleanup(func() { s.Close() })
			seedTaskBoard(t, s, c.open, c.done)
			p, err := s.ListTaskPage(ctx, "team", TaskListQuery{Limit: c.limit})
			require.NoError(t, err)
			doneRows := 0
			for _, it := range p.Tasks {
				if it.Status == "completed" {
					doneRows++
				}
			}
			assert.Len(t, p.Tasks, c.wantRows)
			assert.Equal(t, c.wantDoneRows, doneRows, "done tasks on the first page")
			assert.Equal(t, c.wantCursor, p.NextCursor != "", "a cursor when there is more")
			assert.Equal(t, c.open, p.TotalOpen)
			assert.Equal(t, c.done, p.TotalCompleted)
		})
	}
}

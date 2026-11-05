package resources

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #13724: the record of the queue's use as a list of runs: one row per entry that ended, newest first, with how long it waited and held and how it ended; searchable, filtered by resource and agent, paged by a cursor.

func ev(kind, resource, agent string, at time.Time, id int64, o ...func(*resourcequeue.Event)) resourcequeue.Event {
	e := resourcequeue.Event{At: at, Kind: kind, Resource: resource, Agent: agent, Entry: id}
	for _, f := range o {
		f(&e)
	}
	return e
}

func openRuns(t *testing.T) *History {
	t.Helper()
	h, err := OpenHistory(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(h.Close)
	return h
}

var t0 = time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)

func TestARunIsOneRowWithItsWaitItsHoldAndHowItEnded(t *testing.T) {
	h := openRuns(t)
	h.Add(ev("enqueued", "mac", "a", t0, 1, func(e *resourcequeue.Event) { e.Task, e.Project, e.Via, e.Pattern = 7, "team", "hook", "go test ./..." }))
	h.Add(ev("granted", "mac", "a", t0.Add(2*time.Minute), 1, func(e *resourcequeue.Event) {
		e.Task, e.Project, e.Via, e.Pattern, e.Wait = 7, "team", "hook", "go test ./...", 2*time.Minute
	}))
	h.Add(ev("released", "mac", "a", t0.Add(12*time.Minute), 1, func(e *resourcequeue.Event) {
		e.Task, e.Project, e.Via, e.Pattern, e.Held, e.Why = 7, "team", "hook", "go test ./...", 10*time.Minute, "call ended"
	}))
	h.Flush()
	page, err := h.Runs(RunsQuery{})
	require.NoError(t, err)
	require.Len(t, page.Runs, 1)
	r := page.Runs[0]
	assert.Equal(t, Run{Entry: 1, Resource: "mac", Agent: "a", Task: 7, Project: "team", Via: "hook", Pattern: "go test ./...", Enqueued: t0, Granted: t0.Add(2 * time.Minute), Ended: t0.Add(12 * time.Minute), Wait: 2 * time.Minute, Held: 10 * time.Minute, End: EndCallEnded}, withoutKey(r))
}

func withoutKey(r Run) Run { r.Key = ""; return r }

func TestEachWayAnEntryEndsHasItsOwnReasonAndAnEntryThatNeverRanHasNoHold(t *testing.T) {
	h := openRuns(t)
	add := func(kind string, id int64, held time.Duration, why string) {
		h.Add(ev("enqueued", "mac", fmt.Sprintf("agent%d", id), t0, id))
		if held > 0 {
			h.Add(ev("granted", "mac", fmt.Sprintf("agent%d", id), t0, id))
		}
		h.Add(ev(kind, "mac", fmt.Sprintf("agent%d", id), t0.Add(time.Duration(id)*time.Minute), id, func(e *resourcequeue.Event) { e.Held, e.Why = held, why }))
	}
	add("released", 1, time.Minute, "")
	add("expired", 2, time.Minute, "")
	add("kicked", 3, time.Minute, "")
	add("gone", 4, time.Minute, "")
	add("kicked", 5, 0, "")    // kicked out of the line
	add("cancelled", 6, 0, "") // left the line itself
	add("released", 7, time.Minute, "unclaimed")
	add("released", 8, time.Minute, "cap")
	h.Flush()
	page, err := h.Runs(RunsQuery{})
	require.NoError(t, err)
	got := map[int64]string{}
	for _, r := range page.Runs {
		got[r.Entry] = r.End
	}
	assert.Equal(t, map[int64]string{1: EndReleased, 2: EndExpired, 3: EndKicked, 4: EndGone, 5: EndKickedFromLine, 6: EndLeftLine, 7: EndUnused, 8: EndCap}, got)
	for _, r := range page.Runs {
		if r.Entry == 5 || r.Entry == 6 {
			assert.True(t, r.Granted.IsZero(), "never granted: no start")
			assert.Equal(t, time.Duration(0), r.Held)
		}
	}
	assert.Equal(t, int64(8), page.Runs[0].Entry, "newest first")
}

func TestRunsAreFilteredByResourceAndAgentAndSearchedByWhatAPersonTypes(t *testing.T) {
	h := openRuns(t)
	for i, c := range []struct{ res, agent, pattern string }{{"mac", "Frontend Dev", "go test ./..."}, {"mini", "QA Engineer", "npm run test:cloud"}, {"mac", "QA Engineer", "go build ./..."}} {
		id := int64(i + 1)
		h.Add(ev("enqueued", c.res, c.agent, t0, id, func(e *resourcequeue.Event) { e.Task, e.Pattern = 40+i, c.pattern }))
		h.Add(ev("released", c.res, c.agent, t0.Add(time.Duration(i+1)*time.Minute), id, func(e *resourcequeue.Event) { e.Task, e.Pattern = 40+i, c.pattern }))
	}
	h.Flush()
	ents := func(q RunsQuery) []int64 {
		p, err := h.Runs(q)
		require.NoError(t, err)
		var out []int64
		for _, r := range p.Runs {
			out = append(out, r.Entry)
		}
		return out
	}
	assert.Equal(t, []int64{3, 1}, ents(RunsQuery{Resource: "mac"}))
	assert.Equal(t, []int64{3, 2}, ents(RunsQuery{Agent: "QA Engineer"}))
	assert.Equal(t, []int64{3}, ents(RunsQuery{Resource: "mac", Agent: "QA Engineer"}))
	assert.Equal(t, []int64{2}, ents(RunsQuery{Search: "test:cloud"}), "the pattern")
	assert.Equal(t, []int64{1}, ents(RunsQuery{Search: "frontend"}), "the agent, any case")
	assert.Equal(t, []int64{3}, ents(RunsQuery{Search: "#42"}), "a task as people write it")
	assert.Equal(t, []int64{3, 2, 1}, ents(RunsQuery{Search: "released"}), "how it ended")
	assert.Empty(t, ents(RunsQuery{Search: "kicked"}))
	assert.Empty(t, ents(RunsQuery{Search: "no such thing"}))
	assert.Equal(t, []int64{3, 2, 1}, ents(RunsQuery{Search: "  "}), "blank is no search")
}

func TestRunsComePagedByACursorWithNoRunTwiceOrMissed(t *testing.T) {
	h := openRuns(t)
	for i := int64(1); i <= 120; i++ {
		h.Add(ev("enqueued", "mac", "a", t0, i))
		h.Add(ev("released", "mac", "a", t0.Add(time.Duration(i)*time.Second), i)) // 120 ends, one second apart
	}
	h.Flush()
	var seen []int64
	cursor := ""
	pages := 0
	for {
		p, err := h.Runs(RunsQuery{Limit: 50, Before: cursor})
		require.NoError(t, err)
		pages++
		require.LessOrEqual(t, len(p.Runs), 50, "a page is at most 50")
		for _, r := range p.Runs {
			seen = append(seen, r.Entry)
		}
		if p.Next == "" {
			break
		}
		cursor = p.Next
	}
	assert.Equal(t, 3, pages)
	require.Len(t, seen, 120)
	for i, id := range seen {
		assert.Equal(t, int64(120-i), id, "newest first, each once")
	}
	p, err := h.Runs(RunsQuery{Limit: 5000})
	require.NoError(t, err)
	assert.Len(t, p.Runs, 50, "the page size is capped at 50 whatever is asked")
	_, err = h.Runs(RunsQuery{Before: "not a cursor"})
	assert.Error(t, err, "a bad cursor is refused")
}

func TestTheOptionsAreTheResourcesAndAgentsTheRecordHas(t *testing.T) {
	h := openRuns(t)
	h.Add(ev("released", "mini", "b", t0, 1))
	h.Add(ev("released", "mac", "a", t0.Add(time.Second), 2))
	h.Add(ev("released", "mac", "b", t0.Add(2*time.Second), 3))
	h.Flush()
	p, err := h.Runs(RunsQuery{})
	require.NoError(t, err)
	assert.Equal(t, []string{"mac", "mini"}, p.Resources)
	assert.Equal(t, []string{"a", "b"}, p.Agents)
}

// A folder shaped by the previous release (v2.0.54) has the table without the project and why columns: it opens, its rows are kept and read, and new rows carry both.
func TestAHistoryFileFromThePreviousReleaseIsMigratedAndItsOldRowsStillRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "h.db")
	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE resource_events (
		at INTEGER NOT NULL, kind TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT NOT NULL, task INTEGER NOT NULL DEFAULT 0,
		entry INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT '', pattern TEXT NOT NULL DEFAULT '', wait_ms INTEGER NOT NULL DEFAULT 0, held_ms INTEGER NOT NULL DEFAULT 0);
		CREATE INDEX resource_events_at ON resource_events(at)`)
	require.NoError(t, err)
	ins := func(at time.Time, kind string, id int64, wait, held int64) {
		_, err := db.Exec(`INSERT INTO resource_events (at, kind, resource, agent, task, entry, via, pattern, wait_ms, held_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`, at.UnixMilli(), kind, "mac", "old agent", 3, id, "hook", "go test ./...", wait, held)
		require.NoError(t, err)
	}
	ins(t0, "enqueued", 1, 0, 0)
	ins(t0.Add(time.Minute), "granted", 1, 60000, 0)
	ins(t0.Add(3*time.Minute), "released", 1, 0, 120000)
	require.NoError(t, db.Close())

	h, err := OpenHistory(path)
	require.NoError(t, err, "the old file opens")
	t.Cleanup(h.Close)
	p, err := h.Runs(RunsQuery{})
	require.NoError(t, err)
	require.Len(t, p.Runs, 1, "the old rows are kept")
	r := p.Runs[0]
	assert.Equal(t, "old agent", r.Agent)
	assert.Equal(t, time.Minute, r.Wait)
	assert.Equal(t, 2*time.Minute, r.Held)
	assert.Equal(t, EndReleased, r.End, "no why in an old row: the kind says how it ended")
	assert.Equal(t, "", r.Project, "an old row has no board: its task is text, not a link")

	h.Add(ev("enqueued", "mac", "new", t0.Add(time.Hour), 2, func(e *resourcequeue.Event) { e.Task, e.Project = 9, "team" }))
	h.Add(ev("released", "mac", "new", t0.Add(2*time.Hour), 2, func(e *resourcequeue.Event) { e.Task, e.Project, e.Why = 9, "team", "call ended" }))
	h.Flush()
	p, err = h.Runs(RunsQuery{})
	require.NoError(t, err)
	require.Len(t, p.Runs, 2)
	assert.Equal(t, "team", p.Runs[0].Project)
	assert.Equal(t, EndCallEnded, p.Runs[0].End)
	h.Close()
	h2, err := OpenHistory(path) // and it opens again: the migration is not run twice
	require.NoError(t, err)
	h2.Close()
}

func TestTheNewWaysAnEntryEndsHaveTheirOwnReasons(t *testing.T) { // #13706, #13718: job ended, turn ended, a kept place that ran out
	h := openRuns(t)
	for i, c := range []struct{ kind, why string }{{"released", "job ended"}, {"released", "turn ended"}, {"cancelled", "kept place"}, {"cancelled", "gone"}} {
		id := int64(i + 1)
		h.Add(ev("enqueued", "mac", "a", t0, id))
		h.Add(ev(c.kind, "mac", "a", t0.Add(time.Duration(i+1)*time.Minute), id, func(e *resourcequeue.Event) { e.Why = c.why }))
	}
	h.Flush()
	p, err := h.Runs(RunsQuery{})
	require.NoError(t, err)
	got := map[int64]string{}
	for _, r := range p.Runs {
		got[r.Entry] = r.End
	}
	assert.Equal(t, map[int64]string{1: EndJobEnded, 2: EndTurnEnded, 3: EndKeptPlace, 4: EndGone}, got)
	for _, w := range []struct {
		search string
		want   []int64
	}{{"job ended", []int64{1}}, {"turn ended", []int64{2}}, {"kept place", []int64{3}}} {
		p, err := h.Runs(RunsQuery{Search: w.search})
		require.NoError(t, err)
		var ids []int64
		for _, r := range p.Runs {
			ids = append(ids, r.Entry)
		}
		assert.Equal(t, w.want, ids, w.search)
	}
}

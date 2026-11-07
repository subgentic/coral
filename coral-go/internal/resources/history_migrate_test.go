package resources

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #14222: a record made by an older Coral (no why or renews, one 'renewed' row per renewal) is brought up to the new shape without losing what it says: each hold's renewals become a count on its end row, the
// per-renewal rows of finished holds are removed, a hold with no end row keeps its rows (it may still be running), and doing it twice changes nothing.
func TestAnOlderHistoryKeepsEverythingItSaidWhenItIsMigrated(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "resource_history.db")
	old, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	_, err = old.Exec(`CREATE TABLE resource_events (at INTEGER NOT NULL, kind TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT NOT NULL, task INTEGER NOT NULL DEFAULT 0, entry INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT '', pattern TEXT NOT NULL DEFAULT '', wait_ms INTEGER NOT NULL DEFAULT 0, held_ms INTEGER NOT NULL DEFAULT 0); CREATE INDEX resource_events_at ON resource_events(at)`)
	require.NoError(t, err)
	now := time.Now().UnixMilli()
	ins := func(at int64, kind, res, agent string, entry int) {
		_, err := old.Exec(`INSERT INTO resource_events (at, kind, resource, agent, entry) VALUES (?,?,?,?,?)`, at, kind, res, agent, entry)
		require.NoError(t, err)
	}
	ins(now-9000, "granted", "mac", "a", 5)
	for i := 0; i < 3; i++ {
		ins(now-8000+int64(i), "renewed", "mac", "a", 5)
	}
	ins(now-5000, "released", "mac", "a", 5) // entry 5: three renewals, ended
	ins(now-4000, "granted", "mac", "b", 6)
	ins(now-3500, "renewed", "mac", "b", 6)
	ins(now-3400, "renewed", "mac", "b", 6) // entry 6: two renewals, no end row (still running, or its end was never recorded)
	ins(now-3000, "granted", "mac", "c", 7)
	ins(now-2000, "expired", "mac", "c", 7)  // entry 7: none
	ins(now-1900, "renewed", "mini", "a", 5) // the same entry number on ANOTHER resource is another hold
	require.NoError(t, old.Close())

	h, err := OpenHistory(path)
	require.NoError(t, err)
	evs, err := h.Events(time.UnixMilli(now-20000), time.UnixMilli(now+1000))
	require.NoError(t, err)
	byKind := func(kind, res string, entry int64) []resourcequeue.Event {
		var out []resourcequeue.Event
		for _, e := range evs {
			if e.Kind == kind && e.Resource == res && e.Entry == entry {
				out = append(out, e)
			}
		}
		return out
	}
	rel := byKind("released", "mac", 5)
	require.Len(t, rel, 1)
	assert.Equal(t, 3, rel[0].Renews, "the three renewals are a count on the end row")
	assert.Empty(t, byKind("renewed", "mac", 5), "the rows they came from are gone")
	assert.Len(t, byKind("renewed", "mac", 6), 2, "a hold with no end row keeps its renewal rows")
	assert.Len(t, byKind("renewed", "mini", 5), 1, "another resource's entry with the same number is untouched")
	assert.Equal(t, 0, byKind("expired", "mac", 7)[0].Renews)
	assert.Len(t, byKind("granted", "mac", 5), 1, "nothing else was lost")
	assert.Len(t, byKind("granted", "mac", 6), 1)
	assert.Len(t, evs, 8, "11 rows before, minus the three renewal rows of the finished hold, whose count is kept on its end row")
	// a new event with a why and renews is kept and read back
	h.Add(resourcequeue.Event{At: time.UnixMilli(now), Kind: "released", Resource: "mac", Agent: "d", Entry: 9, Held: time.Second, Why: "idle", Renews: 4})
	h.Flush()
	evs, err = h.Events(time.UnixMilli(now-20000), time.UnixMilli(now+1000))
	require.NoError(t, err)
	got := byKind("released", "mac", 9)
	require.Len(t, got, 1)
	assert.Equal(t, "idle", got[0].Why)
	assert.Equal(t, 4, got[0].Renews)
	h.Close()

	// opened again, nothing changes
	h2, err := OpenHistory(path)
	require.NoError(t, err)
	defer h2.Close()
	again, err := h2.Events(time.UnixMilli(now-20000), time.UnixMilli(now+1000))
	require.NoError(t, err)
	assert.Equal(t, len(evs), len(again), "a second open migrates nothing more")
	var r5 int
	for _, e := range again {
		if e.Kind == "released" && e.Entry == 5 && e.Resource == "mac" {
			r5 = e.Renews
		}
	}
	assert.Equal(t, 3, r5, "and does not count again")
}

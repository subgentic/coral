package resources

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #13671: the queue's use is kept in a small file of its own (counts, names and times; never a command or a note), and a slow, full or broken record never delays or breaks a claim.

func openWithHistory(t *testing.T, dir string) *Manager {
	t.Helper()
	m, err := Open(Options{Path: filepath.Join(dir, "resources.json"), HistoryPath: filepath.Join(dir, "resource_history.db"), AgeStep: -1})
	require.NoError(t, err)
	t.Cleanup(m.Close)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac", Slots: 1}))
	return m
}

func TestTheHistoryKeepsEachChangeOfTheQueueAcrossARestart(t *testing.T) {
	dir := t.TempDir()
	m := openWithHistory(t, dir)
	_, err := m.Claim(t.Context(), "mac", "a", "a secret note")
	require.NoError(t, err)
	_, err = m.Claim(t.Context(), "mac", "b", "")
	require.NoError(t, err)
	require.NoError(t, m.Queue().Release("mac", "a"))
	m.History().Flush()
	m.Close()
	m2 := openWithHistory(t, dir)
	ev, err := m2.History().Events(time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	require.NoError(t, err)
	var kinds []string
	for _, e := range ev {
		kinds = append(kinds, e.Kind+":"+e.Agent)
		assert.NotContains(t, e.Resource+e.Agent+e.Via+e.Pattern, "secret", "no note in the record")
	}
	assert.Equal(t, []string{"enqueued:a", "granted:a", "enqueued:b", "released:a", "granted:b"}, kinds)
}

func TestAHookClaimIsMarkedAutoWithItsPatternAndARefusalIsRecorded(t *testing.T) {
	m := openWithHistory(t, t.TempDir())
	_, err := m.ClaimAuto(t.Context(), "mac", "a", "go test ./...")
	require.NoError(t, err)
	m.Record(resourcequeue.Event{Kind: "refused", Resource: "mac", Agent: "b", Via: "hook", Pattern: "go test ./..."})
	m.History().Flush()
	ev, err := m.History().Events(time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, ev, 3) // enqueued, granted, refused
	assert.Equal(t, "hook", ev[0].Via)
	assert.Equal(t, "go test ./...", ev[0].Pattern)
	assert.Equal(t, "refused", ev[2].Kind)
}

func TestASlowRecordNeverDelaysAClaimAndAFullOneDropsAndCounts(t *testing.T) {
	m := openWithHistory(t, t.TempDir())
	release := make(chan struct{})
	m.History().writeGate = func() { <-release } // the file is stuck
	defer close(release)
	start := time.Now()
	for i := 0; i < 600; i++ { // more than the buffer holds
		m.Record(resourcequeue.Event{Kind: "refused", Resource: "mac", Agent: "x"})
	}
	_, err := m.Claim(t.Context(), "mac", "a", "")
	require.NoError(t, err)
	assert.Less(t, time.Since(start), 2*time.Second, "a stuck record does not hold a claim")
	assert.Greater(t, m.History().Dropped(), int64(0), "what did not fit is counted, not waited for")
}

func TestAHistoryFileThatCannotBeOpenedLeavesTheQueueWorking(t *testing.T) {
	dir := t.TempDir()
	m, err := Open(Options{Path: filepath.Join(dir, "resources.json"), HistoryPath: filepath.Join(dir, "no", "such", "dir", "h.db"), AgeStep: -1})
	require.NoError(t, err, "analytics are lost, never the queue")
	t.Cleanup(m.Close)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac", Slots: 1}))
	r, err := m.Claim(t.Context(), "mac", "a", "")
	require.NoError(t, err)
	assert.True(t, r.Granted)
	assert.Nil(t, m.History())
}

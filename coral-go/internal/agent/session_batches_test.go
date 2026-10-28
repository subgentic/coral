package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10219: a scanner hands its sessions over a batch at a time, and the batches hold the same sessions ExtractSessions returns.
func TestClaudeScannerHandsSessionsOverInBatches(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		dir := filepath.Join(root, fmt.Sprintf("proj%d", i))
		require.NoError(t, os.MkdirAll(dir, 0o755))
		line := fmt.Sprintf(`{"type":"user","timestamp":"2026-10-23T00:00:0%dZ","message":{"role":"user","content":"question %d"}}`+"\n", i, i)
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("00000000-0000-4000-8000-00000000010%d.jsonl", i)), []byte(line), 0o644))
	}
	a := &ClaudeAgent{}
	var batches [][]IndexedSession
	var scanner SessionBatchScanner = a
	require.NoError(t, scanner.ExtractSessionBatches(root, nil, 2, func(b []IndexedSession) error { batches = append(batches, b); return nil }))
	var sizes []int
	var ids []string
	for _, b := range batches {
		sizes = append(sizes, len(b))
		for _, s := range b {
			ids = append(ids, s.SessionID)
		}
	}
	assert.Equal(t, []int{2, 2, 1}, sizes)
	whole, err := a.ExtractSessions(root, nil)
	require.NoError(t, err)
	var wholeIDs []string
	for _, s := range whole {
		wholeIDs = append(wholeIDs, s.SessionID)
	}
	sort.Strings(ids)
	sort.Strings(wholeIDs)
	assert.Equal(t, wholeIDs, ids, "the same sessions, in batches")
	assert.Len(t, ids, 5)

	// an emit that fails stops the batches and is the scanner's error
	calls := 0
	err = a.ExtractSessionBatches(root, nil, 2, func([]IndexedSession) error { calls++; return fmt.Errorf("db down") })
	assert.EqualError(t, err, "db down")
	assert.Equal(t, 1, calls, "nothing more is emitted after a failure")
}

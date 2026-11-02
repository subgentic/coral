package store

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func captureLog(t *testing.T) *bytes.Buffer {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

// #11991: a step of opening the database that takes over the bound is named with its duration; a quick one says nothing; the step's error is returned as it is.
func TestTimedOpenStepNamesASlowStepOnly(t *testing.T) {
	buf := captureLog(t)
	old := slowStepAfter
	t.Cleanup(func() { slowStepAfter = old })
	slowStepAfter = 20 * time.Millisecond
	boom := errors.New("boom")
	require.Equal(t, boom, timedOpenStep("/d/sessions.db", "ensureSchema", func() error { time.Sleep(40 * time.Millisecond); return boom }))
	require.Regexp(t, `\[STARTUP\] sessions\.db: ensureSchema took \d+(\.\d+)?ms`, buf.String())
	buf.Reset()
	require.NoError(t, timedOpenStep("/d/sessions.db", "initAgentTaskEngine", func() error { return nil }))
	require.Empty(t, buf.String(), "a quick step is not logged")
}

// An open names each of its three steps when every one is over the bound (the bound at zero), in the order they run.
func TestOpenLogsEachDatabaseStepWhenSlow(t *testing.T) {
	buf := captureLog(t)
	old := slowStepAfter
	t.Cleanup(func() { slowStepAfter = old })
	slowStepAfter = 0
	db, err := OpenWithKey(context.Background(), filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	defer db.Close()
	out := buf.String()
	last := -1
	for _, step := range []string{"ensureSchema", "scrubRemoteURLCredentials", "initAgentTaskEngine"} {
		i := strings.Index(out, "[STARTUP] sessions.db: "+step+" took ")
		require.Greater(t, i, last, step+" in order: "+out)
		last = i
	}
}

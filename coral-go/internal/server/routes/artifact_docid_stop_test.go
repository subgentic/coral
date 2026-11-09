package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14759: the startup stamping of document ids is a writer in the artifacts folder, so the server that started it stops it and waits for it at shutdown. Before, a test's TempDir cleanup removed the folder while a
// record's temporary file was being written ("directory not empty"), and a real shutdown left the writer running.
func stampableStore(t *testing.T, n int) (coralDir string) {
	t.Helper()
	coralDir = t.TempDir()
	dir := filepath.Join(coralDir, "artifacts", "uploads", "sess")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	for i := 0; i < n; i++ {
		h := sha256.Sum256([]byte(fmt.Sprintf("rec-%d", i)))
		d := hex.EncodeToString(h[:])
		require.NoError(t, os.WriteFile(filepath.Join(dir, d+".json"), []byte(`{"name":"f.txt","media_type":"text/plain","size":3,"digest":"sha256:`+d+`","created_at":"2026-10-01T00:00:00Z"}`), 0o600))
	}
	return coralDir
}

func stampedCount(t *testing.T, coralDir string) (stamped, temps int) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads", "sess"))
	require.NoError(t, err)
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(coralDir, "artifacts", "uploads", "sess", e.Name()))
		if err != nil {
			continue
		}
		if len(e.Name()) != 64+len(".json") {
			temps++
			continue
		}
		if containsDocID(b) {
			stamped++
		}
	}
	return stamped, temps
}

func containsDocID(b []byte) bool { return strings.Contains(string(b), `"doc_id"`) }

func TestStopDocIDMigrationStopsTheWriterAndWaitsForIt(t *testing.T) {
	coralDir := stampableStore(t, 300)
	startDocIDMigration(coralDir)
	StopDocIDMigration(coralDir, 10*time.Second)
	a, temps := stampedCount(t, coralDir)
	assert.Zero(t, temps, "no temporary file of a record being rewritten is left")
	time.Sleep(300 * time.Millisecond) // sleep-ok: a writer that was not stopped would stamp more records in this time
	b, temps2 := stampedCount(t, coralDir)
	assert.Equal(t, a, b, "nothing is written after the stop returned")
	assert.Zero(t, temps2)
	assert.Less(t, a, 300, "the stop came before the migration finished (a stop that waits for the whole store would not be a stop)")
	// a stop with nothing running, and a second stop, are harmless
	StopDocIDMigration(coralDir, time.Second)
	StopDocIDMigration(t.TempDir(), time.Second)
	// and the migration is safe to run again: the next start finishes what the stop left
	res := migrateDocIDs(coralDir)
	assert.Zero(t, res.Failed)
	c, _ := stampedCount(t, coralDir)
	assert.Equal(t, 300, c, "every record has its id after a later full run")
}

package store

import (
	"log"
	"path/filepath"
	"time"
)

// slowStepAfter is how long one step of opening the database may take before the log names it (a test seam).
var slowStepAfter = time.Second

// timedOpenStep runs one step of opening the database and, when it took longer than slowStepAfter, says which and for how long, next to the startup's "opened after" line (#11991): a slow
// open is then ensureSchema, the credential scrub or the task engine, not just "still opening".
func timedOpenStep(dbPath, step string, fn func() error) error {
	start := time.Now()
	err := fn()
	if d := time.Since(start); d >= slowStepAfter {
		log.Printf("[STARTUP] %s: %s took %s", filepath.Base(dbPath), step, d.Round(10*time.Millisecond))
	}
	return err
}

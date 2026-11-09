package routes

import (
	"os"
	"strings"
	"time"
)

// LatestUploadNamed is the digest of the newest artifact that the agent session itself uploaded under this name at or after since ("" when there is none): the context-reset's handoff note (#14849), which Coral
// waits for before it clears an agent. Only the session's own upload records are read (uploads/<session>/), and only an agent's own upload counts, never a file the Operator pasted or a received one.
func LatestUploadNamed(coralDir, session, name string, since time.Time) string {
	dir := uploadsDir(coralDir, session)
	if dir == "" || name == "" {
		return ""
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var best string
	var bestAt time.Time
	for _, f := range files {
		file := f.Name()
		if len(file) != 64+len(".json") || !strings.HasSuffix(file, ".json") {
			continue
		}
		digest := strings.TrimSuffix(file, ".json")
		if !objectNameRe.MatchString(digest) {
			continue
		}
		rec, ok := readUploadRecord(coralDir, session, digest)
		if !ok || !isAgentUploadRecord(rec) || rec.Name != name {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, rec.CreatedAt)
		if err != nil || at.Before(since.Add(-time.Second)) {
			continue
		}
		if best == "" || at.After(bestAt) {
			best, bestAt = digest, at
		}
	}
	return best
}

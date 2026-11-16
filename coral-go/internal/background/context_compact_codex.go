package background

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"time"

	"github.com/subgentic/coral/internal/jsonl"
)

// codexCompactTail is how much of the end of a Codex session file is read to look for a "compacted" record: a compaction that has just happened is among the last lines.
const codexCompactTail = 1 << 20

// codexCompactedSince is whether the Codex session file of sessionID has a "compacted" record written at or after since (#17562): Codex's /compact starts no turn, and this record is what it leaves.
func codexCompactedSince(sessionID string, since time.Time) bool {
	path := jsonl.CodexTranscriptPath(sessionID)
	if path == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	return compactedRecordSince(f, since)
}

// compactedRecordSince scans the last codexCompactTail bytes of f for a {"type":"compacted"} line stamped at or after since.
func compactedRecordSince(f *os.File, since time.Time) bool {
	st, err := f.Stat()
	if err != nil {
		return false
	}
	if off := st.Size() - codexCompactTail; off > 0 {
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			return false
		}
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(`"compacted"`)) {
			continue
		}
		var rec struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Type != "compacted" {
			continue
		}
		if t, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil && !t.Before(since.Add(-time.Second)) {
			return true
		}
	}
	return false
}

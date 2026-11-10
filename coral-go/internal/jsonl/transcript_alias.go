package jsonl

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/transcriptlink"
)

// After a /clear Claude Code starts a new session with a new id and writes a new transcript file, while Coral keeps the id it launched the agent under (#14849, found live): without this Coral went on
// reading the old file, so the chat, the context size, the last message and the search of a cleared agent were stale. The hook reports the new id on the session_reset event; the server records it here
// (and again at start from the events it kept), and the resolver reads that file for the Coral session, but only a file that was started after the reset: an id that names an older transcript (another
// session's, one the agent was told about) is never read in place of the agent's own (Security's SHOULD).
type aliasRecord struct {
	id    string
	since time.Time // when the reset was told: a transcript started before it is not the one
}

var transcriptAliases = struct {
	sync.RWMutex
	m map[string]aliasRecord
}{m: map[string]aliasRecord{}}

// aliasSlack is how far before the told reset a new transcript's first stamp may be (the hook runs a moment after the CLI starts the session, and clocks are not one clock).
const aliasSlack = 30 * time.Second

// SetTranscriptAlias says that the Claude session coralID is now written to the transcript of transcriptID, whose file was started at or after since. An id that is not a session id, or is the same, is
// ignored; "" ends the alias.
func SetTranscriptAlias(coralID, transcriptID string, since time.Time) {
	if !transcriptlink.IsSessionID(coralID) {
		return
	}
	transcriptAliases.Lock()
	defer transcriptAliases.Unlock()
	if transcriptID == "" || transcriptID == coralID {
		delete(transcriptAliases.m, coralID)
		return
	}
	if transcriptlink.IsSessionID(transcriptID) {
		transcriptAliases.m[coralID] = aliasRecord{id: transcriptID, since: since}
	}
}

// TranscriptAlias is the id of the transcript a session is now written to, "" when it is its own.
func TranscriptAlias(coralID string) string {
	transcriptAliases.RLock()
	defer transcriptAliases.RUnlock()
	return transcriptAliases.m[coralID].id
}

func aliasOf(coralID string) (aliasRecord, bool) {
	transcriptAliases.RLock()
	defer transcriptAliases.RUnlock()
	r, ok := transcriptAliases.m[coralID]
	return r, ok
}

// startedAfter reports whether the transcript at path was started at or after since (less the slack): its first stamped line says when. A file with no stamp yet (the CLI has written only its header) is
// not yet known to be new, and a file whose first stamp is older is not the new one.
func startedAfter(path string, since time.Time) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for i := 0; i < 12 && sc.Scan(); i++ {
		var line struct {
			Timestamp string `json:"timestamp"`
			Snapshot  struct {
				Timestamp string `json:"timestamp"`
			} `json:"snapshot"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue
		}
		stamp := line.Timestamp
		if stamp == "" {
			stamp = line.Snapshot.Timestamp
		}
		if stamp == "" {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			continue
		}
		return !at.Before(since.Add(-aliasSlack))
	}
	return false
}

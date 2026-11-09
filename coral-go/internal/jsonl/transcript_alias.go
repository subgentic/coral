package jsonl

import (
	"sync"

	"github.com/subgentic/coral/internal/transcriptlink"
)

// After a /clear Claude Code starts a new session with a new id and writes a new transcript file, while Coral keeps the id it launched the agent under (#14849, found live): without this Coral went on
// reading the old file, so the chat, the context size, the last message and the search of a cleared agent were stale. The hook reports the new id on the session_reset event; the server records it here
// (and again at start from the events it kept), and the resolver reads that file for the Coral session.
var transcriptAliases = struct {
	sync.RWMutex
	m map[string]string
}{m: map[string]string{}}

// SetTranscriptAlias says that the Claude session coralID is now written to the transcript of transcriptID. An id that is not a session id, or is the same, is ignored; "" ends the alias.
func SetTranscriptAlias(coralID, transcriptID string) {
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
		transcriptAliases.m[coralID] = transcriptID
	}
}

// TranscriptAlias is the id of the transcript a session is now written to, "" when it is its own.
func TranscriptAlias(coralID string) string {
	transcriptAliases.RLock()
	defer transcriptAliases.RUnlock()
	return transcriptAliases.m[coralID]
}

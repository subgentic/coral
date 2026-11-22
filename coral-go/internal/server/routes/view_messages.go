package routes

import (
	"net/http"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
)

// What a Hub person who holds only a View grant is answered with when they read a board's messages (#20590 (2), Security V2): a shape built here with a fixed list of fields, never the stored row, so a field added to a message
// later is not shown to them until someone adds it to this list. The text goes through the redactor and is cut; if the redactor cannot run, nothing is shown.
const (
	viewMessageMax      = 100       // messages in one answer
	viewMessageTextMax  = 4000      // characters of one message's text
	viewMessagesBytesAt = 256 << 10 // the answer stops adding messages at about this size
)

// viewMessage is the whole of what one message shows a View person. No sender id, no origin, no Hub person, no cross-team envelope, no task, no ask state.
type viewMessage struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
	JobTitle  string `json:"job_title,omitempty"`
	IsSystem  bool   `json:"is_system"`
}

// viewMessages is the allowlisted, redacted, capped view of messages, newest as given. ok is false when the redactor is unavailable.
func viewMessages(in []board.Message) (out []viewMessage, ok bool) {
	out = []viewMessage{}
	size := 0
	for _, m := range in {
		if len(out) >= viewMessageMax || size >= viewMessagesBytesAt {
			break
		}
		text, ok := redactComment(m.Content) // secrets out BEFORE the cut: a cut can walk a token's boundary
		if !ok {
			return nil, false
		}
		if utf8.RuneCountInString(text) > viewMessageTextMax {
			text = string([]rune(text)[:viewMessageTextMax]) + "…"
		}
		out = append(out, viewMessage{ID: m.ID, Content: text, CreatedAt: m.CreatedAt, JobTitle: m.JobTitle, IsSystem: m.IsSystem})
		size += len(text) + 64
	}
	return out, true
}

// writeViewMessages answers a View person's read. A redactor that cannot run shows nothing.
func writeViewMessages(w http.ResponseWriter, in []board.Message) {
	out, ok := viewMessages(in)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "redactor_unavailable", "messages cannot be shown right now")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

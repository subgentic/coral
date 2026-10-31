package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/secfile"
)

// An agent's newest message is kept on disk as it was last read, so the session list can show it for an agent that has no server running (asleep, or just after a Coral restart) without starting one (#11390).
// It is an excerpt, redacted before it is cut, in a private file of Coral's own folder: the same trust as the agent's session store beside it, and never more than persistedLastRunes.

// persistedLastRunes bounds the text kept on disk: far more than a row shows (140), and cut only after redaction.
const persistedLastRunes = 600

// persistedLastMax bounds what is read back: a record is a few hundred bytes; anything larger is not one.
const persistedLastMax = 8 << 10

func lastDir(dataDir string) string { return filepath.Join(storesDir(dataDir), "last") }

type persistedLast struct {
	Role string `json:"role"`
	Text string `json:"text"`
	At   string `json:"at"`
}

// persistLast writes the agent's newest message, redacted by redact (which must say it could: a text that cannot be checked is not kept, and with no redactor at all nothing is kept) and then cut. Best effort: a failure keeps nothing.
func persistLast(dataDir, key string, m Message, redact func(string) (string, bool)) {
	if !keyRe.MatchString(key) || m.Text == "" || (m.Role != "user" && m.Role != "assistant") {
		return
	}
	if redact == nil {
		return // no way to redact: nothing is kept, never the raw text
	}
	text, ok := redact(m.Text)
	if !ok {
		return
	}
	if r := []rune(text); len(r) > persistedLastRunes {
		text = string(r[:persistedLastRunes])
	}
	b, err := json.Marshal(persistedLast{Role: m.Role, Text: text, At: m.At})
	if err != nil {
		return
	}
	if err := os.MkdirAll(lastDir(dataDir), 0o700); err != nil {
		return
	}
	_ = writePrivate(filepath.Join(lastDir(dataDir), key), b)
}

// PersistedLast is the newest message kept for the agent key, false when there is none or the record is not one.
func PersistedLast(dataDir, key string) (Message, bool) {
	if !keyRe.MatchString(key) {
		return Message{}, false
	}
	f, err := secfile.OpenNoFollow(filepath.Join(lastDir(dataDir), key), os.O_RDONLY, 0) // never through a link planted at the record
	if err != nil {
		return Message{}, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > persistedLastMax {
		return Message{}, false
	}
	var p persistedLast
	if json.NewDecoder(f).Decode(&p) != nil || p.Text == "" || (p.Role != "user" && p.Role != "assistant") {
		return Message{}, false
	}
	return Message{Role: p.Role, Text: p.Text, At: p.At}, true
}

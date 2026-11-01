package transcriptlink

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/safefs"
)

// Hermes (#11831) keeps a session as rows of its state.db, keyed by its own id (local- and 64 hex), not by Coral's session id. Every payload of its hooks names that id, so the hook binds the two: a small link
// in Coral's data folder that the chat reads the session's rows by. Hermes's /new starts another session in the same process, and its hooks then name the new id: the link follows. Believing an id means only
// that the reader asks the team's own home for rows of that id (hermesdb), which a made-up id finds none of.

func hermesLinkDir(dataDir string) string { return filepath.Join(dataDir, "hermes-session-links") }

type hermesLink struct {
	HermesID string `json:"hermes_id"`
}

// HermesSession is the Hermes session a hook bound to a Coral session, or "" with none. The link folder is one the agent can write, so the file is read as a capped regular file (never a link or a FIFO) and its id
// is believed only in the Hermes form.
func HermesSession(dataDir, sessionID string) string {
	if dataDir == "" || !uuid.MatchString(sessionID) {
		return ""
	}
	root, err := safefs.OpenRoot(hermesLinkDir(dataDir))
	if err != nil {
		return ""
	}
	b, err := root.ReadFile(sessionID+".json", maxLinkBytes)
	root.Close()
	if err != nil {
		return ""
	}
	var link hermesLink
	if json.Unmarshal(b, &link) != nil || !hermesdb.IsSessionID(link.HermesID) {
		return ""
	}
	return link.HermesID
}

// BindHermes records which Hermes session a Coral session is, from the session_id of Hermes's own hook payload.
func BindHermes(dataDir, sessionID, hermesID string) error {
	if dataDir == "" {
		return fmt.Errorf("no Coral data folder")
	}
	if !uuid.MatchString(sessionID) {
		return fmt.Errorf("the Coral session id must be a UUID")
	}
	if !hermesdb.IsSessionID(hermesID) {
		return fmt.Errorf("the Hermes session id is not one")
	}
	if HermesSession(dataDir, sessionID) == hermesID {
		return nil
	}
	dir := hermesLinkDir(dataDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(hermesLink{HermesID: hermesID})
	f, err := os.CreateTemp(dir, ".link-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return fsreplace.Rename(f.Name(), filepath.Join(dir, sessionID+".json"))
}

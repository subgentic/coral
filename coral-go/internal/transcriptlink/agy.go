package transcriptlink

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/safefs"
)

// agy (Antigravity CLI) keeps a conversation's transcript at <brain>/<conversation id>/.system_generated/logs/transcript.jsonl, keyed by its own
// conversation id, not by Coral's session id (#7764). Every payload of agy's hooks names that conversation (conversationId), so the hook binds the
// two: a small link, written the way Codex's is, that the transcript readers open the conversation from. The Coral marker in the transcript and
// the workspace in agy's history.jsonl stay as fallbacks that cannot pick another session's conversation.

// AgyBrainDir is the folder agy keeps its conversations in: ANTIGRAVITY_DATA_DIR (or its brain folder) when set, else ~/.gemini/antigravity-cli/brain.
func AgyBrainDir() string {
	base := os.Getenv("ANTIGRAVITY_DATA_DIR")
	if base == "" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".gemini", "antigravity-cli", "brain")
	}
	if filepath.Base(base) != "brain" {
		if info, err := os.Stat(filepath.Join(base, "brain")); err == nil && info.IsDir() {
			return filepath.Join(base, "brain")
		}
	}
	return base
}

func agyLinkDir() string { return filepath.Join(filepath.Dir(AgyBrainDir()), "coral-session-links") }

// AgyTranscript is the transcript file of one agy conversation ("" for an id that is not a plain folder name).
func AgyTranscript(conversationID string) string {
	if !safefs.IsSafeID(conversationID) {
		return ""
	}
	return filepath.Join(AgyBrainDir(), conversationID, ".system_generated", "logs", "transcript.jsonl")
}

type agyLink struct {
	ConversationID string `json:"conversation_id"`
}

// AgyConversation is the agy conversation a hook bound to a Coral session, or "" with none. The link folder is one the agent can write, so the file is read
// as a capped regular file (never a symlink or a FIFO) and its id is believed only as a plain folder name.
func AgyConversation(sessionID string) string {
	if !uuid.MatchString(sessionID) {
		return ""
	}
	root, err := safefs.OpenRoot(agyLinkDir())
	if err != nil {
		return ""
	}
	b, err := root.ReadFile(sessionID+".json", maxLinkBytes)
	root.Close()
	if err != nil {
		return ""
	}
	var link agyLink
	if json.Unmarshal(b, &link) != nil || !safefs.IsSafeID(link.ConversationID) {
		return ""
	}
	return link.ConversationID
}

// BindAgy records which agy conversation a Coral session is, from the conversationId of agy's own hook payload (nothing else: the environment is
// inherited by an agy that a session's agent starts from its shell). A session that already has a link to a conversation that is still there keeps it,
// unless the new conversation's transcript is marked as this session's own: another agy's hook must not take the link over (#4590's rule for Codex).
func BindAgy(sessionID, conversationID string) error {
	if !uuid.MatchString(sessionID) {
		return fmt.Errorf("the Coral session id must be a UUID")
	}
	if !safefs.IsSafeID(conversationID) {
		return fmt.Errorf("the agy conversation id is not a plain name")
	}
	old := AgyConversation(sessionID)
	if old == conversationID {
		return nil
	}
	if old != "" {
		if info, err := os.Stat(filepath.Join(AgyBrainDir(), old)); err == nil && info.IsDir() && agyMarker(conversationID) != sessionID {
			return fmt.Errorf("session %s keeps its link to conversation %s: conversation %s is not marked as this session's", sessionID, old, conversationID)
		}
	}
	dir := agyLinkDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, _ := json.Marshal(agyLink{ConversationID: conversationID})
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

// agyMarker is the Coral session id in the head of a conversation's transcript ("" with none, or with no transcript yet). agy 1.4.7 cuts the long first prompt
// in transcript.jsonl, where Coral's marker sits late in it, so transcript_full.jsonl is read too.
func agyMarker(conversationID string) string {
	path := AgyTranscript(conversationID)
	if path == "" {
		return ""
	}
	for _, p := range []string{path, filepath.Join(filepath.Dir(path), "transcript_full.jsonl")} {
		if id := markerIn(p); id != "" {
			return id
		}
	}
	return ""
}

func markerIn(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(bufio.NewReader(f), markerScanBytes))
	if err != nil {
		return ""
	}
	if m := markerID.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}

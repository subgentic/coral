package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/logsafe"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// hermesChatRows is the most recent rows of a session one chat read takes (the reader bounds a read at hermesdb.MaxMessages; a chat needs fewer).
const hermesChatRows = 2000

// hermesTranscript is a Hermes agent's chat (#11831): the rows of the Hermes session its hooks bound to this Coral session (transcriptlink.HermesSession), read from the state.db of the session's OWN home only
// (agent.HermesAgentHome: the session decides the folder, so another agent's or team's rows are never asked for), read-only and by that one session id (hermesdb). No link yet, no state.db, a layout Coral does not read or a
// failed read is an empty chat, never an error to the person: Hermes may not have run a turn, and a newer Hermes may have changed its tables.
func (h *SessionsHandler) hermesTranscript(ctx context.Context, sessionID string) *jsonl.Transcript {
	return h.hermesTranscriptRows(ctx, sessionID, hermesChatRows)
}

// hermesTranscriptRows is hermesTranscript for the newest rows of the session (the list's last message needs a few, not the chat's two thousand).
func (h *SessionsHandler) hermesTranscriptRows(ctx context.Context, sessionID string, rowLimit int) *jsonl.Transcript {
	empty := jsonl.NewMemoryTranscript(nil)
	if h.cfg == nil || !transcriptlink.IsSessionID(sessionID) {
		return empty
	}
	dataDir := h.cfg.CoralDir()
	hermesID := transcriptlink.HermesSession(dataDir, sessionID)
	if hermesID == "" {
		return empty
	}
	team := ""
	if ls, err := h.ss.GetLiveSession(ctx, sessionID); err == nil && ls != nil && ls.BoardName != nil {
		team = *ls.BoardName
	}
	home := agent.HermesAgentHome(dataDir, team, sessionID)
	if home == "" {
		return empty
	}
	db, err := hermesdb.Open(home)
	if err != nil {
		if !errors.Is(err, hermesdb.ErrNoStore) {
			slog.Debug("hermes: state.db not read", "error", err)
		}
		return empty
	}
	defer db.Close()
	rows, err := db.Messages(ctx, hermesID, 0, rowLimit)
	if err != nil {
		slog.Debug("hermes: messages not read", "error", err)
		return empty
	}
	return jsonl.NewMemoryTranscript(jsonl.ParseHermesMessages(rows))
}

// A Hermes turn the hooks left open is closed by one of two fallbacks, because a Ctrl-C and a provider that gave up fire no closing hook (#11715), and a dot driven by hooks alone would stay Working for ever:
//   - the pane says the operation was interrupted (hermesInterruptedOnScreen: the real notice, captured on v0.22.5), once the last event is at least hermesInterruptSettle old, so a screen that still shows the old notice a second after a new prompt does
//     not end the new turn;
//   - the turn has been silent for hermesTurnSilence since its prompt, with no tool call after it (a tool call can run for hours, and is a working agent).
//
// A request waiting for the person (permission_request) is a wait, not an open turn: neither fallback touches it.
const (
	hermesInterruptSettle = 3 * time.Second
	hermesTurnSilence     = 10 * time.Minute
)

// hermesInterruptedOnScreen reports whether a line "Operation interrupted: <why>" is among the last seven non-empty lines of screen. Hermes v0.22.5 prints it under its name after a Ctrl-C, whatever the turn was
// waiting for ("waiting for model response (6.3s elapsed).", "waiting for the provider to recover (cycle 1/5).", "retrying API call after error (retry 2/3)."), then a footer line and its prompt box, which is why the
// window is seven (the tester's capture, #11831). The line must begin with the notice, so the same words inside other text are not it.
func hermesInterruptedOnScreen(screen string) bool {
	var lines []string
	for _, l := range strings.Split(screen, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	if len(lines) > 7 {
		lines = lines[len(lines)-7:]
	}
	for _, l := range lines {
		if len(l) <= 160 && strings.HasPrefix(l, "Operation interrupted:") {
			return true
		}
	}
	return false
}

// hermesTurnFallback is the state event that closes a turn the hooks left open ("stop" and when), or "" when none applies: events are the session's state events oldest first, screen the agent's screen ("" when
// it could not be read), now the time.
func hermesTurnFallback(events []store.AgentEvent, screen string, now time.Time) (kind string, at time.Time) {
	if len(events) == 0 {
		return "", time.Time{}
	}
	last := events[len(events)-1]
	if last.EventType != "prompt_submit" && last.EventType != "tool_use" {
		return "", time.Time{}
	}
	ts, err := time.Parse(time.RFC3339Nano, last.CreatedAt)
	if err != nil {
		return "", time.Time{}
	}
	age := now.Sub(ts)
	// Silence closes only a turn that has done nothing since its prompt: a tool call can run for an hour (QA's SHOULD on #11831), so a last event that is a tool call is never closed by it.
	if (last.EventType == "prompt_submit" && age >= hermesTurnSilence) || (age >= hermesInterruptSettle && hermesInterruptedOnScreen(screen)) {
		return "stop", now
	}
	return "", time.Time{}
}

// hermesScreen is a Hermes agent's visible screen, "" when it cannot be read (a terminal with no screen, an error): the silence fallback needs none. A read is reused while nothing was written to the pane
// (the same cache the startup prompt's read uses).
func (h *SessionsHandler) hermesScreen(name, agentType, sessionID string) string {
	if sessionID == "" || name == "" {
		return ""
	}
	stamp := ""
	if stamper, _ := h.backend.(ptymanager.OutputStamper); stamper != nil {
		if st, ok := stamper.OutputStamp(agentType, sessionID); ok {
			stamp = st
		}
	}
	_, screen := h.startupScreens.read(promptReadKey(sessionID, name, agentType)+"|hermes", stamp, time.Now(), func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), loginScreenTimeout)
		defer cancel()
		s, err := h.agentScreen(ctx, name, agentType, sessionID, stamp)
		return err == nil, s // the screen itself is what the cache keeps, so a reused read still has it
	})
	return screen
}

// hermesFirstMessageWait bounds how long a Hermes agent's first message waits for Hermes to be ready (the team home's one-time preparation takes about a minute, then Hermes takes 10 to 25 s to draw its screen).
const hermesFirstMessageWait = 15 * time.Minute

// hermesFirstMessageMax is the most of a first message that is read (the board protocol and a launch prompt are a few KB; the agent can write in the folder).
const hermesFirstMessageMax = 256 << 10

// deliverHermesFirstMessage types a Hermes agent its first message, once Hermes is ready (agent.HermesFirstMessagePath: the board protocol, its role and its launch prompt, which are not on the command line so that
// they do not show in ps). The file is read and removed first, so a restart of the same session finds nothing to type twice; the text goes through the same gate as every automated send (nothing typed into an open
// prompt or over a draft, held until it is gone). It runs in the background: a start never waits for it. target is the session's name (with its pane suffix, for tmux).
func (h *SessionsHandler) deliverHermesFirstMessage(team, target string) {
	name := strings.TrimSuffix(target, ".0")
	sid := naming.SessionIDFromName(name)
	if h.cfg == nil || sid == "" {
		return
	}
	path := agent.HermesFirstMessagePath(h.cfg.CoralDir(), team, sid)
	if path == "" {
		return
	}
	// Read and removed through a Root on the file's own folder: the folder is the agent's to write, so a link there is never followed.
	root, err := safefs.OpenRoot(filepath.Dir(path))
	if err != nil {
		return
	}
	b, err := root.ReadFile(filepath.Base(path), hermesFirstMessageMax)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		_ = root.Remove(filepath.Base(path)) // a file that was there is typed at most once, and an unreadable or oversize one is not left to be tried again
	}
	root.Close()
	if err != nil {
		return
	}
	text := strings.TrimSpace(string(b))
	if text == "" {
		return
	}
	safego.Go("routes:hermesFirstMessage", func() {
		wait := h.hermesFirstWait
		if wait <= 0 {
			wait = hermesFirstMessageWait
		}
		ctx, cancel := context.WithTimeout(context.Background(), wait)
		defer cancel()
		if !h.waitForHermesWelcome(ctx, name, sid) {
			// Never typed: Hermes may word its welcome line differently, and the input box is not known to be there, so the text is not sent blind (it could answer a menu). The agent's feed says so instead.
			slog.Warn("hermes: Hermes was not ready for its first message", "session", sid[:8])
			h.noteHermesFirstMessageNotTyped(sid)
			return
		}
		// The launch line may have run another program first (the one-minute preparation of a new home), which the record of the agent's process took for the agent: record it again now Hermes is up (#11936).
		ptymanager.ReadoptLostAgent(ctx, h.terminal, name, at.Hermes, sid)
		if err := deliverAutomated(ctx, h.terminal, name, at.Hermes, sid, text, "first message"); err != nil {
			slog.Warn("hermes: the first message was not typed", "session", sid[:8], "error", err)
		}
	})
}

// hermesWelcome is the line Hermes v0.22.5 shows when it is ready for a message (the tester's capture): the input box's placeholder rotates, so it is not a marker.
const hermesWelcome = "Welcome to Hermes Agent!"

// waitForHermesWelcome waits until the agent's screen shows the welcome line, then hermesSettle more, and reports whether it did before ctx ended. A terminal with no screen to read is not waited for (the gate types
// to such a terminal too). It only reads the screen: nothing is sent because of what is on it.
func (h *SessionsHandler) waitForHermesWelcome(ctx context.Context, name, sid string) bool {
	for {
		rctx, cancel := context.WithTimeout(ctx, loginScreenTimeout)
		screen, err := h.agentScreen(rctx, name, at.Hermes, sid, "")
		cancel()
		if errors.Is(err, errNoScreen) {
			return true
		}
		if err == nil && strings.Contains(screen, hermesWelcome) {
			break
		}
		select {
		case <-time.After(500 * time.Millisecond):
		case <-ctx.Done():
			return false
		}
	}
	select {
	case <-time.After(h.hermesSettle):
		return true
	case <-ctx.Done():
		return false
	}
}

// hermesTurnGoing reports whether the session's state is Working: a turn the hooks opened and nothing (the hooks, the interrupt notice, the silence rule) has closed. A request waiting for the person is not it.
func (h *SessionsHandler) hermesTurnGoing(ctx context.Context, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	return h.deriveSingleSessionState(ctx, sessionID, 0).Working
}

// noteHermesFirstMessageNotTyped puts a notice in the agent's feed that its first message was not typed. Its type (agent_notice) is one no state rule reads, so it changes no state.
func (h *SessionsHandler) noteHermesFirstMessageNotTyped(sessionID string) {
	if h.ts == nil || h.ss == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || ls == nil {
		return
	}
	sid := sessionID
	if _, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{
		AgentName: ls.AgentName, SessionID: &sid, EventType: "agent_notice",
		Summary:   "Hermes did not show its welcome line, so its first message (the board protocol and its task) was not typed: open its terminal and send it by hand",
		CreatedAt: time.Now().UTC().Format(store.ISOFormat),
	}); err != nil {
		slog.Debug("hermes: the notice was not recorded", "error", err)
	}
}

// removeHermesHome removes a deleted Hermes agent's own home (its state.db, hooks and .env), as Kill and a team's kill do: a sleep, a wake and a restart keep it, so the conversation can be resumed. Any other agent
// type has none.
func (h *SessionsHandler) removeHermesHome(agentType, team, sessionID string) {
	if agentType != at.Hermes || h.cfg == nil {
		return
	}
	if err := agent.RemoveHermesHome(h.cfg.CoralDir(), team, sessionID); err != nil {
		slog.Warn("hermes: the agent's home was not removed", "session", sessionID, "error", logsafe.Path(err.Error()))
	}
}

// removeReplacedHermesHome removes the home of a session a restart or a resume replaced with a new one (stored: the replaced session's record, nil when the store did not know it). The replaced session's own team and
// type are the ones its home was made under.
func (h *SessionsHandler) removeReplacedHermesHome(stored *store.LiveSession, team, oldID string) {
	if stored == nil {
		return
	}
	if stored.BoardName != nil {
		team = *stored.BoardName
	}
	h.removeHermesHome(stored.AgentType, team, oldID)
}

// hermesLastMessageRows is how many of a Hermes session's newest rows the list's last message looks through: a long tool-only stretch is a few rows per turn, and 60 reach the last turn with text.
const hermesLastMessageRows = 60

// hermesLastCache remembers each Hermes session's last message with the state of its database (size and modification time of state.db and its write-ahead file) it was read at, so a list that polls every few seconds
// opens the database only when Hermes wrote to it. Bounded: a session that is gone is dropped at the next read of the cache once it is over hermesLastCacheMax.
var hermesLastCache = struct {
	sync.Mutex
	m map[string]hermesLastEntry
}{m: map[string]hermesLastEntry{}}

type hermesLastEntry struct {
	stamp string
	msg   jsonl.LastMessage
	ok    bool
}

const hermesLastCacheMax = 512

// hermesStamp is the state of a session's database files, "" when there is none.
func hermesStamp(home string) string {
	var parts []string
	for _, name := range []string{"state.db", "state.db-wal"} {
		fi, err := os.Lstat(filepath.Join(home, name))
		if err != nil {
			parts = append(parts, "-")
			continue
		}
		parts = append(parts, fmt.Sprintf("%d:%d", fi.Size(), fi.ModTime().UnixNano()))
	}
	return strings.Join(parts, "|")
}

// hermesLastMessage is a Hermes agent's newest message as the list shows it: from its own state.db (there is no transcript file), by the rules of the other agents' (jsonl.LastMessageFromEntries).
func (h *SessionsHandler) hermesLastMessage(sessionID string) (jsonl.LastMessage, bool) {
	if h.cfg == nil || !transcriptlink.IsSessionID(sessionID) {
		return jsonl.LastMessage{}, false
	}
	team := ""
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if ls, err := h.ss.GetLiveSession(ctx, sessionID); err == nil && ls != nil && ls.BoardName != nil {
		team = *ls.BoardName
	}
	home := agent.HermesAgentHome(h.cfg.CoralDir(), team, sessionID)
	if home == "" {
		return jsonl.LastMessage{}, false
	}
	stamp := hermesStamp(home) + "#" + transcriptlink.HermesSession(h.cfg.CoralDir(), sessionID)
	hermesLastCache.Lock()
	e, hit := hermesLastCache.m[sessionID]
	hermesLastCache.Unlock()
	if hit && e.stamp == stamp {
		return e.msg, e.ok
	}
	entries := h.hermesTranscriptRows(ctx, sessionID, hermesLastMessageRows).All(ctx)
	msg, ok := jsonl.LastMessageFromEntries(entries)
	hermesLastCache.Lock()
	if len(hermesLastCache.m) >= hermesLastCacheMax {
		hermesLastCache.m = map[string]hermesLastEntry{}
	}
	hermesLastCache.m[sessionID] = hermesLastEntry{stamp: stamp, msg: msg, ok: ok}
	hermesLastCache.Unlock()
	return msg, ok
}

// What a Hermes agent's conversation does and does not survive (#11956): it lives in a Hermes home of that agent alone (agent.HermesAgentHome), and Hermes keeps no other copy. A wake keeps the home, so the
// conversation continues; a restart gives the agent a new session id and so a new home, and the old one is deleted with its conversation. A conversation cannot be resumed by its Hermes id into another agent.
const (
	hermesRestartNote   = "A restarted Hermes agent starts a new conversation: the old one is deleted with its Hermes home (Hermes keeps no other copy). Wake keeps it."
	hermesResumeRefusal = "A Hermes agent keeps its conversation in its own Hermes home, so it cannot be resumed by its Hermes id into another agent. Wake the same agent to continue its conversation."
)

// hermesHistoryMessages is a Hermes agent's conversation for the history search and its context (#12040, goal #192 slice D): the messages of the Hermes session its hooks bound to this Coral session, read from the
// agent's OWN home's state.db, read-only and capped (hermesdb: MaxMessages rows, each text cut), in the chat's own shape (jsonl.ParseHermesMessages), so an agent finds its own earlier words as a Pi agent does.
// Only the live (or sleeping) agent's: a Kill, a restart and a resume remove the home with the conversation, so an earlier session in a lineage has nothing to read, and says so. With no conversation recorded
// yet the answer says that, in Hermes's words, rather than an error.
func (h *SessionsHandler) hermesHistoryMessages(ctx context.Context, item store.SessionLineageItem) ([]map[string]any, string, error) {
	if !item.IsCurrent && !item.LiveRead {
		return nil, "an earlier Hermes session's conversation was removed with its Hermes home: Hermes keeps no other copy", nil
	}
	if item.SessionID == "" || h.cfg == nil || transcriptlink.HermesSession(h.cfg.CoralDir(), item.SessionID) == "" {
		return nil, "Hermes has not recorded a conversation for this agent yet", nil
	}
	messages := h.hermesTranscriptRows(ctx, item.SessionID, hermesdb.MaxMessages).All(ctx)
	if len(messages) == 0 {
		return nil, "Hermes has not recorded a conversation for this agent yet", nil
	}
	return messages, "", nil
}

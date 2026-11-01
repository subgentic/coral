package routes

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// hermesChatRows is the most recent rows of a session one chat read takes (the reader bounds a read at hermesdb.MaxMessages; a chat needs fewer).
const hermesChatRows = 2000

// hermesTranscript is a Hermes agent's chat (#11831): the rows of the Hermes session its hooks bound to this Coral session (transcriptlink.HermesSession), read from the state.db of the session's TEAM home only
// (agent.HermesTeamHome: a session's team decides the folder, so another team's rows are never asked for), read-only and by that one session id (hermesdb). No link yet, no state.db, a layout Coral does not read or a
// failed read is an empty chat, never an error to the person: Hermes may not have run a turn, and a newer Hermes may have changed its tables.
func (h *SessionsHandler) hermesTranscript(ctx context.Context, sessionID string) *jsonl.Transcript {
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
	db, err := hermesdb.Open(agent.HermesTeamHome(dataDir, team))
	if err != nil {
		if !errors.Is(err, hermesdb.ErrNoStore) {
			slog.Debug("hermes: state.db not read", "error", err)
		}
		return empty
	}
	defer db.Close()
	rows, err := db.Messages(ctx, hermesID, 0, hermesChatRows)
	if err != nil {
		slog.Debug("hermes: messages not read", "error", err)
		return empty
	}
	return jsonl.NewMemoryTranscript(jsonl.ParseHermesMessages(rows))
}

// A Hermes turn the hooks left open is closed by one of two fallbacks, because a Ctrl-C and a provider that gave up fire no closing hook (#11715), and a dot driven by hooks alone would stay Working for ever:
//   - the pane says the operation was interrupted (hermesInterruptedOnScreen: the real notice, captured on v0.22.5), once the last event is at least hermesInterruptSettle old, so a screen that still shows the old notice a second after a new prompt does
//     not end the new turn;
//   - the turn has been silent for hermesTurnSilence. Every tool call fires a pre and a post hook, so ten minutes with none is not a working agent.
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
	if age >= hermesTurnSilence || (age >= hermesInterruptSettle && hermesInterruptedOnScreen(screen)) {
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
		ctx, cancel := context.WithTimeout(context.Background(), hermesFirstMessageWait)
		defer cancel()
		if err := deliverAutomated(ctx, h.terminal, name, at.Hermes, sid, text, "first message"); err != nil {
			slog.Warn("hermes: the first message was not typed", "session", sid[:8], "error", err)
		}
	})
}

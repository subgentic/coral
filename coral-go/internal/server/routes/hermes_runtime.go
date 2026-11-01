package routes

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/ptymanager"
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
//   - the pane says the operation was interrupted (hermesInterruptedOnScreen), once the last event is at least hermesInterruptSettle old, so a screen that still shows the old notice a second after a new prompt does
//     not end the new turn;
//   - the turn has been silent for hermesTurnSilence. Every tool call fires a pre and a post hook, so ten minutes with none is not a working agent.
//
// A request waiting for the person (permission_request) is a wait, not an open turn: neither fallback touches it. The interrupt text is from the tester's report of v0.22.5, not a capture of the screen, so
// that part is to be confirmed against a real one.
const (
	hermesInterruptSettle = 3 * time.Second
	hermesTurnSilence     = 10 * time.Minute
)

// hermesInterruptedOnScreen reports whether the notice "Operation interrupted" is among the last three non-empty lines of screen, as a short line of its own.
func hermesInterruptedOnScreen(screen string) bool {
	var lines []string
	for _, l := range strings.Split(screen, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	for _, l := range lines {
		if len(l) <= 60 && strings.Contains(strings.ToLower(l), "operation interrupted") {
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

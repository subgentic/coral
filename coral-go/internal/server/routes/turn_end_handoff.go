package routes

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
)

// TurnEndHandoffSetting turns the turn-end hand-off off when "off" (#3481, #3475 3A).
// It is on by default, for Claude agents on a board (team agents Coral launches);
// an agent with no board, which a person drives, never gets it.
const TurnEndHandoffSetting = "turn_end_handoff"

// TurnEndHandoff is called by a Claude agent's Stop hook when its turn ends (#3481,
// #3475 3A). If the agent has unread board messages, the answer tells the hook to keep
// the agent going with them: Claude Code continues with the hook's reason and context,
// so nothing is typed into its terminal and no prompt can be answered by mistake (a turn
// ends with no request open).
//
// Only the agent's own hook may call it (its session token, in every mode), once per
// stop chain (stop_hook_active: Claude's own guard against a hook that always blocks).
// POST /api/sessions/live/{name}/turn-end
func (h *SessionsHandler) TurnEndHandoff(w http.ResponseWriter, r *http.Request) {
	owner, hasToken := VerifiedSession(r.Context())
	if !hasToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session_token_required",
			"message": "The turn-end hand-off is for the agent's own Stop hook, with its session token"})
		return
	}
	var body struct {
		StopHookActive bool `json:"stop_hook_active"`
	}
	_ = decodeJSON(r, &body)
	none := map[string]any{"handoff": false}
	if body.StopHookActive {
		writeJSON(w, http.StatusOK, none)
		return
	}
	ctx := r.Context()
	ls, err := h.ss.GetLiveSession(ctx, owner.SessionID)
	if err != nil || ls == nil || ls.AgentType != at.Claude || ls.BoardName == nil || *ls.BoardName == "" || h.bs == nil {
		writeJSON(w, http.StatusOK, none)
		return
	}
	if settings, _ := h.ss.GetSettings(ctx); setreg.Enum(settings, TurnEndHandoffSetting) == "off" {
		writeJSON(w, http.StatusOK, none)
		return
	}
	if ptymanager.PersonSendActive(owner.SessionID) {
		// A person's send to this agent is in flight, or its text may still be in the box: a hand-off starts the agent's next turn, and the person's Enter would compete with it (#10996, #10992). The messages stay
		// unread: the notifier's reminder, or the next turn's end, hands them over.
		writeJSON(w, http.StatusOK, none)
		return
	}
	board := *ls.BoardName
	counts, err := h.bs.GetUnreadCountsForSessions(ctx, []string{owner.SessionName})
	unread := counts[owner.SessionName]
	if err != nil || unread <= 0 {
		writeJSON(w, http.StatusOK, none)
		return
	}
	// At most one hand-off per window per agent, so an agent flooded with board messages is not sent from turn to turn without a pause (#10996 (a)): what waits is handed over when the window is over, or by the
	// notifier's reminder. A message that @mentions the agent, or is from the Operator, goes at once; a check that fails counts as one (today's behaviour).
	if !h.handoffs.due(owner.SessionID) {
		switch h.handoffUrgency(ctx, owner.SessionName) {
		case urgentNow:
		case urgentExternal:
			if !h.handoffs.dueExternal(owner.SessionID) {
				slog.Info("turn-end hand-off held: a copy from another board waits the floor", "session", owner.SessionName, "unread", unread)
				writeJSON(w, http.StatusOK, none)
				return
			}
		default:
			slog.Info("turn-end hand-off held: one per window", "session", owner.SessionName, "unread", unread)
			writeJSON(w, http.StatusOK, none)
			return
		}
	}
	h.handoffs.mark(owner.SessionID)
	// A nudge typed during a turn is not an acknowledgement: Claude may end
	// without acting on it (#8557). Unread messages still need a hand-off now,
	// rather than waiting for the notifier's reminder window. An actual board
	// read clears unread above; StopHookActive still bounds this to one per chain.
	plural := "s"
	if unread == 1 {
		plural = ""
	}
	slog.Info("turn-end hand-off: the agent goes on with its board messages", "session", owner.SessionName, "board", board, "unread", unread)
	writeJSON(w, http.StatusOK, map[string]any{
		"handoff": true,
		// Claude shows the reason as "Stop hook error: <reason>" whatever it says
		// (verified on 2.1.300), so it is kept short; the instruction is the context,
		// shown as "Stop hook feedback".
		"reason":  "New board messages",
		"context": fmt.Sprintf("Coral board: %d new message%s on %s. Run coral-board read to read them, then carry on.", unread, plural, board),
	})
}

// TurnEndHandoffEvery is the least time between two hand-offs to one agent (#10996 (a)): an agent flooded with board messages (cross-board copies that `coral-board read` does not clear) was sent from turn to turn
// with no pause, and a person's send could not land in it (#10992). A message that @mentions the agent, or is from the Operator, is not held by it.
const TurnEndHandoffEvery = 60 * time.Second

// TurnEndHandoffExternalFloor is the least time between two hand-offs when the only urgent-looking message is a copy from ANOTHER board (#11012, Security's SHOULD on #11009). A cross-board copy is posted
// with its recipients' @mentions, so it always looks like a mention; counting it as urgent let a flood of copies (or an agent on another board that was told to keep one going) hand the agent from turn to
// turn with no pause. It is not held for the whole window, since it can be real work from another team: 10 s, Security's suggestion. A message from a same-board sender that @mentions the agent, or from the
// Operator, still goes at once. A hand-off that is held is not lost: the messages stay unread, and arrive at the agent's next turn end, or with the notifier's 15-minute reminder, not 60 s later.
const TurnEndHandoffExternalFloor = 10 * time.Second

// handoffLimiter remembers when each agent was last handed over. Its zero value is ready.
type handoffLimiter struct {
	mu    sync.Mutex
	last  map[string]time.Time
	every time.Duration // a test's own window; zero: TurnEndHandoffEvery
	floor time.Duration // a test's own floor for another board's mention; zero: TurnEndHandoffExternalFloor
}

func (l *handoffLimiter) setEvery(d time.Duration)         { l.mu.Lock(); l.every = d; l.mu.Unlock() }
func (l *handoffLimiter) setExternalFloor(d time.Duration) { l.mu.Lock(); l.floor = d; l.mu.Unlock() }

// dueExternal reports whether the agent may be handed a message from another board now: the floor since its last hand-off is over (#11012).
func (l *handoffLimiter) dueExternal(sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	floor := l.floor
	if floor == 0 {
		floor = TurnEndHandoffExternalFloor
	}
	at, ok := l.last[sessionID]
	return !ok || time.Since(at) >= floor
}

// due reports whether the agent may be handed over now: it never was, or the window since the last one is over.
func (l *handoffLimiter) due(sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	every := l.every
	if every == 0 {
		every = TurnEndHandoffEvery
	}
	at, ok := l.last[sessionID]
	return !ok || time.Since(at) >= every
}

// mark records a hand-off to the agent now.
func (l *handoffLimiter) mark(sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.last == nil {
		l.last = map[string]time.Time{}
	}
	l.last[sessionID] = time.Now()
}

// How urgent an agent's unread messages are for its turn-end hand-off (#10996 (a), #11012).
const (
	urgentNone     = iota // nothing that mentions the agent, or is from the Operator: the whole window
	urgentExternal        // a mention that came from another board (a cross-board copy always @mentions its recipients): the short floor
	urgentNow             // a same-board mention, or the Operator's message: at once
)

// handoffUrgency says how urgent the agent's unread messages are. A check that fails counts as urgent now (today's behaviour).
func (h *SessionsHandler) handoffUrgency(ctx context.Context, sessionName string) int {
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, sessionName)
	if err != nil || sub == nil {
		return urgentNow
	}
	if local, err := h.bs.HasUnreadLocalMention(ctx, sub.Project, sub.SubscriberID); err != nil || local {
		return urgentNow
	}
	if op, err := h.bs.HasUnreadOperatorMessage(ctx, sub.Project, sub.SubscriberID); err != nil || op {
		return urgentNow
	}
	if any, err := h.bs.HasUnreadMention(ctx, sub.Project, sub.SubscriberID); err != nil || any {
		return urgentExternal
	}
	return urgentNone
}

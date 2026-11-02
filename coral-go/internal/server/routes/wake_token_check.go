package routes

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// A woken agent's Coral token, checked (#12291): a few seconds after a wake typed the launch line, did the agent get the token that line carries, and is it still the live one? A token the agent does not
// have, or one a later launch line replaced (a new token revokes the one before), shows as every coral-board call answering 401, and nothing said why. The check says so, once: in the log with the
// session's ids, as a line on the agent's board, and in the live list (coral_token_problem) until the agent is next started. It changes nothing about the agent.

// wakeTokenCheckAfter is how long after a wake the check looks (the shell has run the line by then); a var for tests.
var wakeTokenCheckAfter = 15 * time.Second

// the reasons, fixed words (never taken from the agent)
const (
	tokenReplaced = "replaced" // a later launch line minted a new token: the one the agent holds is revoked
	tokenUnread   = "unread"   // the token's file is still there: the agent's shell did not read it
)

const tokenProblemSentence = "Its Coral token was not accepted after it woke, so its coral-board calls will be refused. Restart it from Coral."

type tokenProblem struct {
	reason string
	at     time.Time
}

var tokenProblems sync.Map // session id -> tokenProblem

// tokenProblemSentence is the live list's words for a session, "" when there is none.
func tokenProblemOf(sessionID string) string {
	if _, ok := tokenProblems.Load(sessionID); ok {
		return tokenProblemSentence
	}
	return ""
}

// forgetTokenProblem ends the note: the agent was started again with a token of its own.
func forgetTokenProblem(sessionID string) { tokenProblems.Delete(sessionID) }

// watchWakeToken notes the live token now (just after the launch line was typed) and checks it again after wakeTokenCheckAfter.
func (h *SessionsHandler) watchWakeToken(ls *store.LiveSession) {
	if h.db == nil || h.ss == nil {
		return
	}
	live0, err := h.db.LiveSessionTokenCreated(context.Background(), ls.SessionID)
	if err != nil || live0 == "" {
		return // no token was minted (a test, or a server without them): nothing to compare
	}
	forgetTokenProblem(ls.SessionID)
	sid, agentType := ls.SessionID, ls.AgentType
	time.AfterFunc(wakeTokenCheckAfter, func() { h.checkWakeToken(sid, agentType, live0) })
}

// checkWakeToken is the check itself, and says why when it finds a problem.
func (h *SessionsHandler) checkWakeToken(sessionID, agentType, live0 string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cur, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || cur == nil || cur.IsSleeping == 1 || cur.IsArchived == 1 {
		return // gone or asleep again: there is no agent whose token could be wrong
	}
	live1, err := h.db.LiveSessionTokenCreated(ctx, sessionID)
	if err != nil {
		return
	}
	reason := ""
	switch {
	case live1 != live0:
		reason = tokenReplaced
	case agentType != at.Codex && agent.SessionTokenFileFor != nil:
		if p := agent.SessionTokenFileFor(sessionID); p != "" {
			if _, serr := os.Stat(p); serr == nil {
				reason = tokenUnread
			}
		}
	}
	if reason == "" {
		return
	}
	tokenProblems.Store(sessionID, tokenProblem{reason: reason, at: time.Now()})
	slog.Warn("[identity] a woken agent's Coral token was not accepted", "session_id", sessionID, "session_name", naming.SessionName(agentType, sessionID), "reason", reason)
	if h.bs != nil && ptr.Value(cur.BoardName) != "" {
		if title := h.noticeName(ctx, *cur); title != "" {
			_, _ = h.bs.PostSystemMessage(ctx, ptr.Value(cur.BoardName), board.CoralSender, "@"+title+" "+tokenProblemSentence, nil)
		}
	}
	h.kickWS()
}

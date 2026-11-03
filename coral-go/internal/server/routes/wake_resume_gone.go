package routes

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// A Claude agent whose conversation is gone (#12714). `claude --resume <id>` of a session whose transcript no longer exists prints "No conversation found with session ID" and returns to the shell, and a wake left a bare
// shell with the session marked awake. The wake now looks for the transcript BEFORE it launches and, with none, starts the agent fresh: the same session id, folder, role and board, with its start prompt as a new launch of
// that member has, and the board is told once. The CLI's own line is a backstop for a transcript that was there when looked at and not when Claude read it. Codex and Hermes already start a new conversation when they have nothing
// to resume (codexSessionSaved; Hermes resumes only by its own id); the other CLIs' resume was not changed.

// claudeConversationFound says whether the Claude conversation of a session still has its transcript (a variable so a test can say it has not).
var claudeConversationFound = func(sessionID, workingDir string) bool {
	return jsonl.ResolveClaudeTranscript(sessionID, workingDir) != ""
}

// conversationGoneLine is what the Claude CLI prints when it is asked to resume a conversation it does not have.
const conversationGoneLine = "No conversation found with session ID"

// wakeResumeCheckAfter is how long after a Claude resume the backstop reads the agent's log for that line; a variable for tests.
var wakeResumeCheckAfter = 12 * time.Second

// resumeGone holds the sessions whose CLI said its conversation is gone (session id -> when it was said): the wake the backstop starts then starts it fresh without looking again. It lives resumeGoneLife at most, and the backstop
// clears it as soon as that wake returns, launched or not: a wake that did not launch (the CLI was still alive) must not leave it for a later, unrelated wake to start fresh.
var resumeGone sync.Map

const resumeGoneLife = time.Minute

// forceFresh reports (and forgets) that the CLI said, within the last minute, that the conversation of sessionID is gone.
func forceFresh(sessionID string) bool {
	v, ok := resumeGone.LoadAndDelete(sessionID)
	if !ok {
		return false
	}
	at, _ := v.(time.Time)
	return time.Since(at) < resumeGoneLife
}

// freshStartNote is the one line the board gets when an agent was started fresh.
func (h *SessionsHandler) noteFreshStart(ctx context.Context, ls *store.LiveSession) {
	bn := ptr.Value(ls.BoardName)
	if h.bs == nil || bn == "" {
		return
	}
	name := h.noticeName(ctx, *ls)
	if name == "" {
		return
	}
	if _, err := h.bs.PostSystemMessage(ctx, bn, board.CoralSender, name+" could not resume its conversation, so it started fresh.", nil); err != nil {
		log.Printf("[wake] session=%s: the fresh-start note was not posted: %v", naming.SessionName(ls.AgentType, ls.SessionID), err)
	}
}

// watchResumeGone is the backstop: a while after a Claude resume, look at the agent's log for the CLI's own line, and when it is there start the agent fresh in the same terminal (the wake's own path for an exited CLI).
func (h *SessionsHandler) watchResumeGone(ls *store.LiveSession) {
	if ls.AgentType != at.Claude || h.cfg == nil {
		return
	}
	logFile := naming.LogFile(h.cfg.LogDir, ls.AgentType, ls.SessionID)
	sid := ls.SessionID
	time.AfterFunc(wakeResumeCheckAfter, func() {
		m, _ := readLogTail(logFile, nil)
		lines, _ := m["recent_lines"].([]string)
		saw := false
		for _, l := range lines {
			if strings.Contains(l, conversationGoneLine) {
				saw = true
			}
		}
		if !saw {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cur, err := h.ss.GetLiveSession(ctx, sid)
		if err != nil || cur == nil || cur.IsArchived == 1 {
			return
		}
		log.Printf("[wake] session=%s: the CLI could not find its conversation; starting it fresh", naming.SessionName(ls.AgentType, sid))
		resumeGone.Store(sid, time.Now())
		err = h.wakeExistingSession(ctx, cur)
		resumeGone.Delete(sid) // used by that wake's own look, or not used at all (it did not launch): never left for a later wake
		if err != nil {
			log.Printf("[wake] session=%s: the fresh start failed: %v", naming.SessionName(ls.AgentType, sid), err)
		}
	})
}

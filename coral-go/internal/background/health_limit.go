package background

import (
	"context"
	"errors"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
)

// screenReader is what an agent runtime offers to show an agent's screen (the PTY and tmux runtimes both do).
type screenReader interface {
	AgentScreen(ctx context.Context, name, agentType, sessionID string) (string, error)
}

// screenLimit reads a usage limit off an agent's screen: agy (#5229) and Codex (#9267) report the quota being used up only in their own
// text, with no hook event, so an agent that cannot work looked idle (or, after a nudge started a turn the limit cut short, "working") to
// the check. Other agent types report their limits through their transcripts and are not looked at here. A runtime that cannot show a
// screen sees no limit.
func screenLimit(rt AgentRuntime) func(ctx context.Context, a AgentInfo) (time.Duration, bool) {
	sr, ok := rt.(screenReader)
	if !ok {
		return nil
	}
	type seen struct {
		at     time.Time
		resets time.Duration
		ok     bool
	}
	var mu sync.Mutex
	cache := map[string]seen{} // the roster and the nudges ask often; a screen is read at most every limitScreenTTL per agent
	return func(ctx context.Context, a AgentInfo) (time.Duration, bool) {
		if a.AgentType != at.Agy && a.AgentType != at.Antigravity && a.AgentType != at.Codex {
			return 0, false
		}
		mu.Lock()
		c, hit := cache[a.SessionID]
		mu.Unlock()
		if hit && time.Since(c.at) < limitScreenTTL {
			return c.resets, c.ok
		}
		screen, err := sr.AgentScreen(ctx, naming.SessionName(a.AgentType, a.SessionID), a.AgentType, a.SessionID)
		if err != nil {
			return 0, false
		}
		var resets time.Duration
		var ok bool
		if a.AgentType == at.Codex {
			resets, ok = ptymanager.CodexLimitOnScreen(screen, time.Now())
		} else {
			resets, ok = ptymanager.AgyQuotaOnScreen(screen)
		}
		mu.Lock()
		cache[a.SessionID] = seen{time.Now(), resets, ok}
		mu.Unlock()
		return resets, ok
	}
}

const limitScreenTTL = 10 * time.Second

// blockedByLimit says whether a is stopped by a usage limit, and when it resets.
func (m *BoardHealthMonitor) blockedByLimit(ctx context.Context, a AgentInfo) (time.Duration, bool) {
	if m.limit == nil {
		return 0, false
	}
	return m.limit(ctx, a)
}

// errBlockedByLimit: an automatic message was not sent to an agent that is stopped by a usage limit (it cannot act on it, and the nudge
// itself started the turn the limit cut short).
var errBlockedByLimit = errors.New("agent is stopped by a usage limit")

// sendUnlessBlocked types text to a through deliver, unless a is stopped by a usage limit.
func sendUnlessBlocked(ctx context.Context, limit func(context.Context, AgentInfo) (time.Duration, bool), deliver func(context.Context, AgentInfo, string, string) error, a AgentInfo, key, text string) error {
	if limit != nil {
		if _, blocked := limit(ctx, a); blocked {
			return errBlockedByLimit
		}
	}
	return deliver(ctx, a, key, text)
}

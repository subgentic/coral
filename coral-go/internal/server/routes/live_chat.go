package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/live"
	"github.com/subgentic/coral/internal/naming"
)

// Coral Live chat wiring (#21094): where an agent's session is found and its transcript read, for the live source. The reader is the transcript's allowlist (jsonl.ChatTail): a typed user turn or an assistant
// reply with words, nothing else.

// liveChatCacheTTL is how long one session's chat read is reused: the pusher builds a frame every second and the transcript changes far less often.
const liveChatCacheTTL = 2 * time.Second

// LiveChat gives the live source what it needs for chat: the session an agent's subscription holds (its id, CLI, folder and the times of its run) and a reader of its newest chat messages.
func (h *SessionsHandler) LiveChat() (live.SessionLookup, live.ChatReader) {
	lookup := func(ctx context.Context, sessionName string) (live.SessionFacts, bool) {
		if h.ss == nil {
			return live.SessionFacts{}, false
		}
		ls, err := h.ss.GetLiveSession(ctx, naming.SessionIDFromName(sessionName))
		if err != nil || ls == nil {
			return live.SessionFacts{}, false
		}
		f := live.SessionFacts{ID: ls.SessionID, Type: ls.AgentType, WorkingDir: ls.WorkingDir, Created: ls.CreatedAt}
		if ls.LaunchedAt != nil {
			f.Launched = *ls.LaunchedAt
		}
		return f, true
	}
	return lookup, h.chatReader()
}

type liveChatEntry struct {
	at   time.Time
	rows []live.ChatRow
	ok   bool
}

func (h *SessionsHandler) chatReader() live.ChatReader {
	var mu sync.Mutex
	cache := map[string]liveChatEntry{}
	return func(f live.SessionFacts, n int) ([]live.ChatRow, bool) {
		if h.jsonl == nil {
			return nil, false
		}
		key := f.ID + "|" + f.Type
		mu.Lock()
		if e, hit := cache[key]; hit && time.Since(e.at) < liveChatCacheTTL {
			mu.Unlock()
			return e.rows, e.ok
		}
		mu.Unlock()
		msgs, ok := h.jsonl.ChatTail(f.ID, f.WorkingDir, f.Type, n)
		var rows []live.ChatRow
		for _, m := range msgs {
			from := "agent"
			if m.Role == "user" {
				from = "person"
			}
			t, _ := time.Parse(time.RFC3339Nano, m.At) // no readable time: the zero time, no time on the wire
			rows = append(rows, live.ChatRow{From: from, Text: m.Text, At: t})
		}
		mu.Lock()
		if len(cache) > 64 {
			cache = map[string]liveChatEntry{}
		}
		cache[key] = liveChatEntry{at: time.Now(), rows: rows, ok: ok}
		mu.Unlock()
		return rows, ok
	}
}

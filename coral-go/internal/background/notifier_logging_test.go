package background

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

func captureNotifierLogs(n *BoardNotifier) *bytes.Buffer {
	var buf bytes.Buffer
	n.logger = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return &buf
}

// A session that never joined a board is normal: no INFO line per pass.
func TestBoardNotifier_UnsubscribedSessionNotLoggedAtInfo(t *testing.T) {
	bs := testBoardStore(t)
	n := NewBoardNotifier(bs, &mockRuntime{}, 10*time.Second)
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", AgentName: "solo", SessionID: "11111111-2222-3333-4444-555555555555"}}, nil
	})
	logs := captureNotifierLogs(n)

	require.NoError(t, n.RunOnce(context.Background()))
	assert.NotContains(t, logs.String(), "no subscription found")
	assert.NotContains(t, logs.String(), "subscription lookup failed")
}

// A real lookup error still surfaces, at WARN, with the error.
func TestBoardNotifier_SubscriptionLookupErrorLoggedAtWarn(t *testing.T) {
	bs := testBoardStore(t)
	n := NewBoardNotifier(bs, &mockRuntime{}, 10*time.Second)
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", AgentName: "solo", SessionID: "11111111-2222-3333-4444-555555555555"}}, nil
	})
	logs := captureNotifierLogs(n)
	require.NoError(t, bs.Close())

	require.NoError(t, n.RunOnce(context.Background()))
	out := logs.String()
	assert.Contains(t, out, "level=WARN msg=\"subscription lookup failed\"")
	assert.Contains(t, out, "error=")
}

// Mentions-mode nudges with the incremental unread count: chatter and system
// messages never nudge, each new mention re-nudges with the current count, and
// deleting or reading messages is reflected on the next pass.
func TestBoardNotifier_MentionsNudgesTrackUnreadCount(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	rt := &mockRuntime{}
	n := NewBoardNotifier(bs, rt, 10*time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	captureNotifierLogs(n)
	sid := "11111111-2222-3333-4444-555555555555"
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", AgentName: "dev", SessionID: sid, DisplayName: "Dev"}}, nil
	})
	_, err := bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-"+sid, nil, "mentions")
	require.NoError(t, err)
	post := func(from, text string) int64 {
		m, err := bs.PostMessage(ctx, "team", from, text, nil)
		require.NoError(t, err)
		return m.ID
	}
	lastNudge := func() string {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		if len(rt.sent) == 0 {
			return ""
		}
		return rt.sent[len(rt.sent)-1].text
	}
	pass := func() { require.NoError(t, n.RunOnce(ctx)) }

	post("Lead", "general chatter")
	post("Coral Task Queue", "@Dev task assigned")
	post("Dev", "@Dev talking to myself")
	pass()
	assert.Empty(t, rt.sent)

	first := post("Lead", "@Dev please look")
	pass()
	assert.Contains(t, lastNudge(), "You have 1 unread message on")

	post("Lead", "Dev: and this too")
	n.now = func() time.Time { return time.Now().Add(2 * defaultRemindAfter) }
	pass()
	assert.Contains(t, lastNudge(), "You have 2 unread messages")

	_, err = bs.DeleteMessage(ctx, "team", first)
	require.NoError(t, err)
	n.now = func() time.Time { return time.Now().Add(4 * defaultRemindAfter) }
	pass()
	assert.Contains(t, lastNudge(), "You have 1 unread message on")

	_, err = bs.ReadMessages(ctx, "team", "Dev", 50)
	require.NoError(t, err)
	sent := len(rt.sent)
	n.now = func() time.Time { return time.Now().Add(6 * defaultRemindAfter) }
	pass()
	assert.Len(t, rt.sent, sent, "no nudge once everything is read")
}

// Routine passes are quiet: nothing at INFO for subscribers with nothing new
// or already nudged. Only sending a nudge is logged at INFO.
func TestBoardNotifier_RoutinePassesLogNothingAtInfo(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	rt := &mockRuntime{}
	n := NewBoardNotifier(bs, rt, 10*time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	var agents []AgentInfo
	for i := 0; i < 5; i++ {
		sid := fmt.Sprintf("11111111-2222-3333-4444-%012d", i)
		name := fmt.Sprintf("Dev%d", i)
		agents = append(agents, AgentInfo{AgentType: "claude", AgentName: name, SessionID: sid, DisplayName: name})
		_, err := bs.Subscribe(ctx, "team", name, "Developer", "claude-"+sid, nil, "mentions")
		require.NoError(t, err)
	}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return agents, nil })

	logs := captureNotifierLogs(n)
	require.NoError(t, n.RunOnce(ctx))
	assert.NotContains(t, logs.String(), "level=INFO", "nothing unread")

	_, err := bs.PostMessage(ctx, "team", "Lead", "@Dev0 please look", nil)
	require.NoError(t, err)
	logs = captureNotifierLogs(n)
	require.NoError(t, n.RunOnce(ctx))
	assert.Contains(t, logs.String(), `level=INFO msg="sending nudge"`)
	assert.Equal(t, 1, strings.Count(logs.String(), "level=INFO"), "only the nudge itself")

	logs = captureNotifierLogs(n)
	require.NoError(t, n.RunOnce(ctx))
	assert.NotContains(t, logs.String(), "level=INFO", "already notified")
}

// Real lookup failures are WARN with the error.
func TestBoardNotifier_UnreadLookupFailureIsWarn(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board.db")
	bs, err := board.NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	sid := "11111111-2222-3333-4444-555555555555"
	_, err = bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-"+sid, nil, "mentions")
	require.NoError(t, err)
	raw, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	defer raw.Close()
	_, err = raw.Exec("DROP TABLE board_messages")
	require.NoError(t, err)

	n := NewBoardNotifier(bs, &mockRuntime{}, 10*time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", AgentName: "Dev", SessionID: sid, DisplayName: "Dev"}}, nil
	})
	logs := captureNotifierLogs(n)
	require.NoError(t, n.RunOnce(ctx))
	out := logs.String()
	assert.Contains(t, out, `level=WARN msg="check unread failed"`)
	assert.Contains(t, out, "error=")
	assert.NotContains(t, out, "level=INFO")
}

// #11182: a sleep-paused board with an awake agent on it is resumed by the notifier and the mention is nudged (the pause was saved before a restart and nothing lifted it: no nudge for hours); a
// pause a person set is not lifted and is logged at INFO, once per board, so a board that is silent is never silent without a line saying why.
func TestBoardNotifier_ASleepPausedBoardWithAnAwakeAgentIsResumedAndNudged(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	rt := &mockRuntime{}
	n := NewBoardNotifier(bs, rt, 10*time.Second)
	paused := map[string]bool{"team": true}
	sleepOnly := true
	n.SetIsPausedFn(func(p string) bool { return paused[p] })
	n.SetLiftSleepPauseFn(func(p string) bool {
		if paused[p] && sleepOnly {
			delete(paused, p)
			return true
		}
		return false
	})
	logs := captureNotifierLogs(n)
	sid := "11111111-2222-3333-4444-555555555555"
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", AgentName: "dev", SessionID: sid, DisplayName: "Dev"}}, nil
	})
	_, err := bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-"+sid, nil, "mentions")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "team", "Lead", "@Dev please look", nil)
	require.NoError(t, err)

	require.NoError(t, n.RunOnce(ctx))
	require.Len(t, rt.sent, 1, "the board was resumed and the mention nudged")
	assert.False(t, paused["team"])
	assert.Contains(t, logs.String(), "resumed a board that sleep had paused")

	// A person's pause: nothing is sent, and the board is named once at INFO, not on every pass.
	paused["team"], sleepOnly = true, false
	_, err = bs.PostMessage(ctx, "team", "Lead", "@Dev and this", nil)
	require.NoError(t, err)
	sent := len(rt.sent)
	for i := 0; i < 3; i++ {
		n.now = func() time.Time { return time.Now().Add(time.Duration(i+3) * 2 * defaultRemindAfter) }
		require.NoError(t, n.RunOnce(ctx))
	}
	assert.Len(t, rt.sent, sent, "a person's pause is kept")
	assert.Equal(t, 1, strings.Count(logs.String(), "level=INFO msg=\"board paused: no nudges go out until it is resumed\""), "once per board, at INFO")
	assert.Contains(t, logs.String(), "project=team")
}

package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/live"
	"github.com/subgentic/coral/internal/store"
)

// Coral Live chat through the routes (#21094): chat is offered only for an agent whose session is known and whose CLI has tested chat; the preview shows the real messages; a restart turns it off.

func TestChatThroughTheRoutesNeedsASessionAndATestedCLIAndEndsWithARestart(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	const sidB, sidQ = "11111111-0000-4000-8000-00000000000b", "22222222-0000-4000-8000-00000000000c"
	_, err := h.bs.Subscribe(ctx, "team", "Backend Dev", "backend", "claude-"+sidB, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "QA Engineer", "qa", "opencode-"+sidQ, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "No Session", "ux", "claude-33333333-0000-4000-8000-00000000000d", nil, "all")
	require.NoError(t, err)

	launched := "2026-11-24T10:00:00Z"
	var reads atomic.Int32
	lh := openLiveHandler(h)
	lh.SetChat(func(_ context.Context, name string) (live.SessionFacts, bool) {
		switch name {
		case "claude-" + sidB:
			return live.SessionFacts{ID: sidB, Type: "claude", Created: "2026-11-24T09:00:00Z", Launched: launched}, true
		case "opencode-" + sidQ:
			return live.SessionFacts{ID: sidQ, Type: "opencode", Created: "2026-11-24T09:00:00Z"}, true
		}
		return live.SessionFacts{}, false
	}, func(f live.SessionFacts, n int) ([]live.ChatRow, bool) {
		reads.Add(1)
		return []live.ChatRow{{From: "person", Text: "hello agent", At: time.Unix(1700000000, 0)}, {From: "agent", Text: "hello person", At: time.Unix(1700000001, 0)}}, true
	})

	by := map[string]liveCall{}
	for _, c := range liveRoutes() {
		by[c.method+" "+c.path] = c
	}
	code, out := by["POST /api/live/links"].do(lh, "", livePerson)
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := out["id"].(string)
	call := func(method, tail, body string) (int, map[string]any) {
		var c liveCall
		for _, r := range liveRoutes() {
			if r.method == method && strings.HasSuffix(r.path, tail) {
				c = r
			}
		}
		c.id = id
		return c.do(lh, body, livePerson)
	}
	for _, key := range []string{"QA Engineer", "No Session"} {
		code, out = call("PUT", "/views", `{"chat_key":"`+key+`"}`)
		assert.Equal(t, http.StatusBadRequest, code, key)
		assert.Equal(t, "chat_unavailable", out["error"], key+": a CLI with no tested chat, or no session, has none")
	}
	code, out = call("PUT", "/views", `{"chat_key":"Backend Dev"}`)
	require.Equal(t, http.StatusOK, code, "%v", out)

	code, out = call("GET", "/preview", "")
	require.Equal(t, http.StatusOK, code)
	agents := out["frame"].(map[string]any)["agents"].([]any)
	var chat []any
	for _, a := range agents {
		if c, ok := a.(map[string]any)["chat"].([]any); ok {
			chat = c
		}
	}
	require.Len(t, chat, 2, "the preview shows the real messages")
	assert.Equal(t, "hello agent", chat[0].(map[string]any)["text"])
	hash := out["hash"].(string)

	code, out = call("POST", "/go-live", `{"hash":"`+hash+`","read":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	m, err := lh.manager()
	require.NoError(t, err)
	f, err := m.Frame(ctx, id, 1)
	require.NoError(t, err)
	require.Len(t, f.Agents[0].Chat, 2)

	// a wake stamps the launch time: it is another run, and the chat the person approved is not shown under it
	launched = "2026-11-24T12:00:00Z"
	before := reads.Load()
	f, err = m.Frame(ctx, id, 2)
	require.NoError(t, err)
	for _, a := range f.Agents {
		assert.Empty(t, a.Chat)
	}
	assert.Equal(t, before, reads.Load(), "the transcript is not opened for a new session")
	require.NoError(t, m.Tick(ctx))
	l, _ := m.Get(id)
	assert.Empty(t, l.Approved.ChatKey, "the next Tick turns chat off")
	assert.Equal(t, "the agent restarted", l.ChatOffWhy)
}

// Security INFO (#21080): the active Hub links are read once per couple of seconds, not twice per link every second.
func TestTheActiveHubLinksAreReadOnceForAShortWhile(t *testing.T) {
	_, h := setupBoardTestServer(t)
	lh := openLiveHandler(h)
	var reads atomic.Int32
	lh.hubLinks = func(context.Context) []HubLinkInfo {
		reads.Add(1)
		return []HubLinkInfo{{ID: "lnk-11111111", Label: "Acme", Active: true}}
	}
	for i := 0; i < 20; i++ {
		assert.True(t, lh.linkActive("lnk-11111111"))
		assert.False(t, lh.linkActive("lnk-other"))
	}
	assert.EqualValues(t, 1, reads.Load(), "forty asks, one store read")
	lh.cacheMu.Lock()
	lh.cacheAt = time.Now().Add(-linkActiveTTL - time.Millisecond)
	lh.cacheMu.Unlock()
	assert.True(t, lh.linkActive("lnk-11111111"))
	assert.EqualValues(t, 2, reads.Load(), "read again once the time is up")
	assert.False(t, lh.linkActive(""))
}

// The sessions handler's half: the session facts come from the live_sessions row (a restart, a resume or a wake changes them) and the messages from the transcript, a person's typed words and the agent's replies only.
func TestTheSessionsHandlerGivesTheLiveSourceItsSessionAndChat(t *testing.T) {
	_, sh, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	const sid = "11111111-0000-4000-8000-0000000000e1"
	lines := []string{
		`{"type":"user","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":"typed words"}}`,
		`{"type":"assistant","timestamp":"2026-10-29T10:00:01.000Z","message":{"content":[{"type":"text","text":"spoken words"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"TOOL-OUTPUT"}]}}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Backend Dev", WorkingDir: "/w"}))

	lookup, read := sh.LiveChat()
	f, ok := lookup(ctx, "claude-"+sid)
	require.True(t, ok)
	assert.Equal(t, sid, f.ID)
	assert.Equal(t, "claude", f.Type)
	assert.NotEmpty(t, f.Created)
	_, ok = lookup(ctx, "claude-99999999-0000-4000-8000-0000000000ff")
	assert.False(t, ok, "a session the store does not have has no facts, so no chat")

	rows, ok := read(f, 12)
	require.True(t, ok)
	require.Len(t, rows, 2)
	assert.Equal(t, live.ChatRow{From: "person", Text: "typed words", At: time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC)}, rows[0])
	assert.Equal(t, "agent", rows[1].From)
	assert.Equal(t, "spoken words", rows[1].Text)
	for _, r := range rows {
		assert.NotContains(t, r.Text, "TOOL-OUTPUT")
	}
}

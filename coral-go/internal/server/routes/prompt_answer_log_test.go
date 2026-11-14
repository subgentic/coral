package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// a permission prompt whose second option names a folder, all on the option's own line
const screenPathOption = `⏺ Read(notes.txt)
  ⎿  Waiting…
────────────────────────────────────────────────────────────────────
 Read file
   notes.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /Users/someone/cc-probe/
   3. No
 Esc to cancel
`

// The "answer-prompt sent" line says which option by its number and a fixed kind, never its words: an option can name a folder or a command (#16440, Security INFO on #16398).
func TestAnswerPromptLogLineHasNoOptionText(t *testing.T) {
	server, _, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-00000000a5c1"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-log", WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-log", "/tmp/test")
	promptTextDelay = 0
	fastPromptChecks(t)
	set := func(s string) { terminal.mu.Lock(); terminal.outputs["claude-log"] = s; terminal.mu.Unlock() }
	terminal.onRaw = func(string) { set(screenIdleList) }
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })

	set(screenPathOption)
	base := server.URL + "/api/sessions/live/claude-log"
	chat, err := http.Get(base + "/chat?" + url.Values{"session_id": {sid}, "agent_type": {"claude"}, "after": {"1"}}.Encode())
	require.NoError(t, err)
	var reply struct {
		PromptOptions promptScreen `json:"prompt_options"`
	}
	require.NoError(t, json.NewDecoder(chat.Body).Decode(&reply))
	chat.Body.Close()
	require.Len(t, reply.PromptOptions.Options, 3)
	opt := reply.PromptOptions.Options[1] // "Yes, and always allow access to <folder> from this project": its label holds a path
	require.Contains(t, opt.Label, "cc-probe", "the option under test names a folder: "+opt.Label)
	b, _ := json.Marshal(map[string]any{"n": 2, "label": opt.Label, "session_id": sid, "agent_type": "claude"})
	resp, err := http.Post(base+"/answer-prompt", "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	var got map[string]any
	json.NewDecoder(resp.Body).Decode(&got)
	require.Equal(t, http.StatusOK, resp.StatusCode, "%v", got)
	resp.Body.Close()

	var line string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, "answer-prompt sent") {
			line = l
		}
	}
	require.NotEmpty(t, line, "the success line was logged: "+buf.String())
	require.NotContains(t, line, "cc-probe", "no folder from the option")
	require.NotContains(t, line, "allow reading", "none of the option's words")
	require.NotContains(t, line, "label=")
	require.Contains(t, line, "n=2")
	require.Contains(t, line, "kind=allow")
}

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #11399: every agent's permission card shows the whole request or says it cannot and offers only Reject, and the server refuses an Allow for such a request. One rule (internal/permreview): the request is shown
// whole up to 4,000 bytes; one that is longer, or holds a control or format character other than a newline or a tab, can only be rejected, and the character is written out (<U+202E>), never drawn raw.
// Claude and Pi report the tool they are about to run (the pending tool); Codex and agy are read from the screen, where what the CLI itself cuts cannot be known.
func TestEveryAgentsPermissionCardShowsTheWholeRequestOrOffersOnlyReject(t *testing.T) {
	cases := []struct {
		name, command string
		onlyReject    bool
	}{
		{"a clean command of 400 bytes", "echo " + strings.Repeat("x", 395), false},
		{"a clean command of 600 bytes", "echo " + strings.Repeat("x", 595), false},
		{"a command longer than the card shows", "echo " + strings.Repeat("x", 4100), true},
		{"a right-to-left override", "echo ok ‮", true},
		{"a zero-width space", "echo o​k", true},
		{"a tail after a run of blanks", "echo ok" + strings.Repeat(" ", 100) + "rm", true},
		{"a Windows line end", "echo a\r\necho b", false},
	}
	for _, agent := range []string{at.Claude, at.Pi, at.Codex} {
		for _, tc := range cases {
			t.Run(agent+": "+tc.name, func(t *testing.T) {
				server, h, terminal, ss := setupSessionsTestServer(t)
				const sid = "00000000-0000-0000-0000-00000000c0de"
				name := agent + "-card"
				require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: agent, AgentName: name, WorkingDir: "/tmp/test"}))
				terminal.addSession(name, "/tmp/test")
				fastPromptChecks(t)
				promptTextDelay = 0
				screenText := screenPermission
				if agent == at.Codex { // read from the screen: the command is on it, and nothing else says what it is
					screenText = strings.ReplaceAll(screenPermission, "touch probe_file.txt", tc.command)
				}
				setScreen := func(s string) {
					terminal.mu.Lock()
					terminal.outputs[name] = s
					terminal.mu.Unlock()
				}
				setScreen(screenText)
				terminal.onRaw = func(string) { setScreen(screenIdleList) }
				if agent != at.Codex { // the hook reports the tool before its prompt
					h.pending.set(sid, newPendingTool("tu1", "Bash", map[string]any{"command": tc.command}, time.Now()))
				}
				base := server.URL + "/api/sessions/live/" + name
				q := url.Values{"session_id": {sid}, "agent_type": {agent}, "after": {"1"}}.Encode()
				resp, err := http.Get(base + "/chat?" + q)
				require.NoError(t, err)
				var reply struct {
					Pending *struct {
						Input map[string]any `json:"input"`
					} `json:"pending"`
					PromptOptions promptScreen `json:"prompt_options"`
				}
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&reply))
				resp.Body.Close()
				require.NotEmpty(t, reply.PromptOptions.Options, "the card has its answers")

				var shown string
				var only bool
				var note string
				if agent == at.Codex {
					shown, only, note = reply.PromptOptions.Target, reply.PromptOptions.OnlyReject, reply.PromptOptions.Note
				} else {
					require.NotNil(t, reply.Pending)
					shown, _ = reply.Pending.Input["command"].(string)
					only, _ = reply.Pending.Input["only_reject"].(bool)
					note, _ = reply.Pending.Input["note"].(string)
				}
				assert.Equal(t, tc.onlyReject, only, "only Reject is offered exactly when the request is cut or hides something")
				assert.False(t, strings.ContainsAny(shown, "‮​\r"), "a hidden character is written out, never drawn raw")
				if tc.onlyReject {
					assert.NotEmpty(t, note, "and the card says why in words")
				} else {
					assert.Empty(t, note)
					assert.Contains(t, shown, strings.TrimSpace(strings.Split(strings.ReplaceAll(tc.command, "\r", ""), "\n")[0]), "the whole request is shown")
					assert.Contains(t, shown, strings.TrimSpace(tc.command[strings.LastIndex(tc.command, "\n")+1:]), "to its last line")
				}
				if strings.Contains(tc.command, "‮") {
					assert.Contains(t, shown, "<U+202E>")
				}

				answer := func(n int, label string) (int, map[string]any) {
					b, _ := json.Marshal(map[string]any{"n": n, "label": label, "session_id": sid, "agent_type": agent})
					r, err := http.Post(base+"/answer-prompt", "application/json", bytes.NewReader(b))
					require.NoError(t, err)
					defer r.Body.Close()
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					return r.StatusCode, body
				}
				if tc.onlyReject {
					code, body := answer(1, "Yes")
					assert.Equal(t, http.StatusConflict, code, "an Allow is refused by the server")
					assert.Equal(t, "only_reject", body["code"])
					terminal.mu.Lock()
					assert.Empty(t, terminal.raw[name], "no key was typed")
					terminal.mu.Unlock()
					setScreen(screenText)
					code, _ = answer(4, "No")
					assert.Equal(t, http.StatusOK, code, "Reject is answered")
				} else {
					code, _ := answer(1, "Yes")
					assert.Equal(t, http.StatusOK, code, "a request shown whole and clean can be allowed")
				}
			})
		}
	}
}

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

type capturedHandoffScreen string

func (s capturedHandoffScreen) AgentScreen(context.Context, string, string, string) (string, error) {
	return string(s), nil
}

// #8557: delivery is not acknowledgement. The agent can finish a turn without
// reading its board despite a nudge typed mid-turn. These captures are rendered
// text supplied by the Orchestrator, with the home path masked, not raw PTY bytes.
func TestTurnEndHandsOffUnreadAfterMidTurnDelivery8557(t *testing.T) {
	for _, mode := range []string{"all", "mentions"} {
		for _, fixture := range []string{"devops_screen.txt", "devops_idle_screen.txt"} {
			t.Run(mode+"/"+fixture, func(t *testing.T) {
				server, h, _, ss := setupSessionsTestServer(t)
				ctx := context.Background()
				sid := "eeeeeeee-8557-0000-0000-000000000001"
				name := "claude-" + sid
				board := "turn-end-8557"
				require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "worker8557", WorkingDir: "/work", BoardName: &board}))
				tok := agentToken(t, h, sid, name)
				_, err := h.bs.Subscribe(ctx, board, "Worker", "DevOps Engineer", name, nil, mode)
				require.NoError(t, err)
				_, err = h.bs.Subscribe(ctx, board, "Lead", "Orchestrator", "", nil, "all")
				require.NoError(t, err)
				_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "worker8557", SessionID: &sid, EventType: "prompt_submit", Summary: "turn begins", CreatedAt: time.Now().UTC().Add(-time.Minute).Format(store.ISOFormat)})
				require.NoError(t, err)
				_, err = h.bs.PostMessage(ctx, board, "Lead", "@Worker please read this new board message", nil)
				require.NoError(t, err)
				screen, err := os.ReadFile("testdata/turn_end_8557/" + fixture)
				require.NoError(t, err)
				typed := 0
				t.Cleanup(func() { ptymanager.ForgetSession(name) })
				delivered, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{Term: capturedHandoffScreen(screen), Name: name, AgentType: "claude", SessionID: sid, Text: "You have 1 unread message", What: "board nudge", Send: func(context.Context) error { typed++; return nil }})
				require.NoError(t, err)
				require.Equal(t, ptymanager.Sent, delivered)
				require.Equal(t, 1, typed)
				ask := func(active bool) map[string]any {
					body := `{"stop_hook_active":false}`
					if active {
						body = `{"stop_hook_active":true}`
					}
					req, err := http.NewRequest("POST", server.URL+"/api/sessions/live/worker8557/turn-end", strings.NewReader(body))
					require.NoError(t, err)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set(store.SessionTokenHeader, tok)
					resp, err := http.DefaultClient.Do(req)
					require.NoError(t, err)
					defer resp.Body.Close()
					require.Equal(t, http.StatusOK, resp.StatusCode)
					var out map[string]any
					require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
					return out
				}
				// No read after the nudge: Stop must resume now, inside the reminder window.
				out := ask(false)
				assert.Equal(t, true, out["handoff"], "a typed nudge did not make the unread message read")
				if out["handoff"] == true {
					assert.Contains(t, out["context"], "coral-board read")
				}
				assert.Equal(t, false, ask(true)["handoff"], "still only once per stop chain")
				messages, err := h.bs.ReadMessages(ctx, board, "Worker", 50)
				require.NoError(t, err)
				require.Len(t, messages, 1)
				assert.Equal(t, false, ask(false)["handoff"], "an actual board read prevents a duplicate handoff")
			})
		}
	}
}

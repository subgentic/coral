package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// plainScreen is a terminal whose screen is a working line with no input box, and which types into a list.
type plainScreen struct {
	mu    sync.Mutex
	typed []string
}

func (*plainScreen) AgentScreen(context.Context, string, string, string) (string, error) {
	return "⏺ Reading files…\n", nil
}

func (p *plainScreen) sent() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.typed...)
}

// #7554: the Operator's Send now. A message held on a false "needs input" is listed (no text), delivered once by the route, and a second press finds nothing.
func TestSendNowRouteListsAndDeliversAHeldMessageOnce(t *testing.T) {
	server, _, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-0000000075a1"
	name := "claude-" + sid
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))
	terminal.addSession(name, "/tmp/test")
	ptymanager.SetNeedsInputFunc(func(context.Context, string, string, string) bool { return true })
	t.Cleanup(func() { ptymanager.SetNeedsInputFunc(nil); ptymanager.DropHeld(name, "test") })
	term := &plainScreen{}
	for _, text := range []string{"first secret text", "second"} {
		d, err := ptymanager.DeliverAutomated(context.Background(), ptymanager.AutomatedInput{Term: term, Name: name, AgentType: "claude", SessionID: sid, Key: text, Text: text, What: "board message",
			Send: func(context.Context) error {
				term.mu.Lock()
				term.typed = append(term.typed, text)
				term.mu.Unlock()
				return nil
			}})
		require.NoError(t, err)
		require.Equal(t, ptymanager.Held, d)
	}

	target := "?agent_type=claude&session_id=" + sid
	resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/held" + target)
	require.NoError(t, err)
	var list struct {
		Held []heldRow `json:"held"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	resp.Body.Close()
	require.Len(t, list.Held, 2)
	assert.Equal(t, "board message", list.Held[0].What)
	raw, _ := json.Marshal(list)
	assert.NotContains(t, string(raw), "secret", "the list carries no message text")

	send := func(id string) map[string]any {
		body, _ := json.Marshal(map[string]string{"agent_type": "claude", "session_id": sid, "id": id})
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/held/send", "application/json", bytes.NewReader(body))
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	out := send(list.Held[0].ID)
	assert.EqualValues(t, 1, out["sent"])
	assert.EqualValues(t, 1, out["left"])
	assert.Equal(t, []string{"first secret text"}, term.sent())
	out = send(list.Held[0].ID) // the second press
	assert.EqualValues(t, 0, out["sent"])
	assert.Equal(t, []string{"first secret text"}, term.sent())
	out = send("") // all that is left
	assert.EqualValues(t, 1, out["sent"])
	assert.Equal(t, []string{"first secret text", "second"}, term.sent())
	require.Eventually(t, func() bool { return ptymanager.HeldCount(name) == 0 }, 2*time.Second, 10*time.Millisecond)
}

func TestSendNowRouteNamesItsTargetExactly(t *testing.T) {
	server, _, _, _ := setupSessionsTestServer(t)
	resp, err := http.Post(server.URL+"/api/sessions/live/claude-x/held/send", "application/json", bytes.NewBufferString(`{"id":""}`))
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "no session_id: nothing is sent")
}

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #15952 (the Operator): a Codex agent's chat said "Codex is starting" and the row said "Waiting in the terminal" while the terminal showed it up and waiting for input; typing cleared it. Both notices
// come from the absence of a first hook event, and these CLIs fire none until their first turn. The list now reads the screen for an agent with no event: its own input box on screen, with no prompt open,
// is a ready agent, neither starting nor unstarted; a prompt, or no screen at all, leaves both as they were.
func TestAnAgentWithNoEventSittingAtItsInputBoxIsNotStartingAndNotUnstarted(t *testing.T) {
	for _, c := range []struct{ agent, version, idle, prompt string }{
		{"codex", "0.155.1", "idle.ansi", "trust.ansi"},
		{"agy", "", "idle.ansi", "permission_menu.ansi"},
	} {
		t.Run(c.agent, func(t *testing.T) {
			screens := func(name string) string {
				if c.agent == "agy" {
					b, err := os.ReadFile("../../ptymanager/testdata/screens/agy/1.3.5/" + name)
					require.NoError(t, err)
					return sgrStrip(string(b))
				}
				return corpusScreen(t, c.agent, c.version, name)
			}
			require.True(t, ptymanager.InputBoxOnScreen(screens(c.idle)), "the recorded idle screen is an input box")
			require.False(t, ptymanager.InputBoxOnScreen(screens(c.prompt)), "the recorded prompt screen is not")

			server, h, mock, ss := setupSessionsTestServer(t)
			term := &loginScreenTerminal{mockSessionTerminal: mock}
			h.terminal = term
			ctx := context.Background()
			sid := "00000000-0000-4000-8000-0000000015f2"
			name := naming.SessionName(c.agent, sid)
			mock.addSession(name, "/tmp/test")
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: c.agent, AgentName: "ready", WorkingDir: "/tmp/test", CreatedAt: time.Now().UTC().Format(time.RFC3339)}))
			// silent for a minute: past the 25 s that makes the row say "not started"
			logFile := naming.LogFile(h.cfg.LogDir, c.agent, sid)
			require.NoError(t, os.WriteFile(logFile, []byte("a CLI banner\n"), 0o600))
			old := time.Now().Add(-time.Minute)
			require.NoError(t, os.Chtimes(logFile, old, old))

			row := func(screen string) map[string]any {
				t.Helper()
				term.set(screen)
				h.startupScreens = loginScreens{stampDecides: true} // a fresh screen read each time
				resp, err := http.Get(server.URL + "/api/sessions/live")
				require.NoError(t, err)
				defer resp.Body.Close()
				var rows []map[string]any
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
				for _, r := range rows {
					if r["session_id"] == sid {
						return r
					}
				}
				t.Fatal("the agent is not in the live list")
				return nil
			}
			r := row(screens(c.idle))
			assert.Equal(t, false, r["not_started"], "at its input box: not 'Waiting in the terminal'")
			assert.Equal(t, false, r["starting"], "at its input box: not 'starting'")
			r = row(screens(c.prompt))
			assert.True(t, r["not_started"] == true || r["waiting_for_input"] == true, "a prompt open on the screen keeps the row asking for the terminal")
			r = row("")
			assert.Equal(t, true, r["not_started"], "no screen to read: as before")
		})
	}
}

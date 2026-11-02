package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #11936 (the tester's run on v2.0.29): a Hermes agent woken after a sleep started a plain `hermes chat`, a new empty session, and lost its conversation. Hermes resumes only by its own id (local- and 64 hex), never
// Coral's, so the wake passes the one Coral recorded from the agent's hooks (transcriptlink.HermesSession), as one argument. An agent with none recorded starts a new session, as before.
func TestWakeOfAHermesAgentResumesItsRecordedConversation(t *testing.T) {
	hermesID := "local-" + strings.Repeat("9f", 32)
	for _, tc := range []struct {
		name   string
		bind   string
		resume bool
	}{
		{"its recorded conversation is resumed", hermesID, true},
		{"none recorded: a new session", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bin := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(bin, "hermes"), []byte("#!/bin/sh\n"), 0o755))
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			_, h, term, ss := setupSessionsTestServer(t)
			ctx := context.Background()
			const id = "00000000-0000-0000-0000-0000000057f4"
			team := "team-a"
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "hermes", AgentName: "repo", WorkingDir: t.TempDir(), BoardName: &team}))
			require.NoError(t, ss.SetSessionSleeping(ctx, id, true))
			if tc.bind != "" {
				require.NoError(t, transcriptlink.BindHermes(h.cfg.CoralDir(), id, tc.bind))
			}
			req := dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+id+"/wake", nil), map[string]string{"sessionID": id})
			rec := httptest.NewRecorder()
			h.WakeSession(rec, req)
			require.Contains(t, rec.Body.String(), `"ok":true`, rec.Body.String())
			cmd := ""
			for _, c := range term.sentCommands() { // the launch line; a board prompt may be typed after it
				if strings.Contains(c, "HERMES_HOME=") {
					cmd = c
				}
			}
			require.NotEmpty(t, cmd, "the agent's start command was typed")
			require.Contains(t, cmd, " chat")
			if tc.resume {
				assert.Contains(t, cmd, " --resume "+hermesID)
			} else {
				assert.NotContains(t, cmd, "--resume")
			}
		})
	}
}

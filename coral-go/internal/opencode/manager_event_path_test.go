package opencode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// On the real 1.19.5 a turn's busy and idle come on /event; /api/event carries only message and session updates. A 1.x server's state is read from /event, a 2.x server's from /api/event (found by the end-to-end
// run: the dot never moved and no chat or last message appeared, #137997).
func TestAnAgentsStateIsReadFromTheEventStreamItsVersionPutsItOn(t *testing.T) {
	assert.Equal(t, "/event", EventPath(1))
	assert.Equal(t, "/api/event", EventPath(2))
	assert.Equal(t, "/api/event", EventPath(3))
	// the frames 1.19.5 really sends on /event
	frames := "data: {\"id\":\"e1\",\"type\":\"server.connected\",\"properties\":{}}\n\n" +
		"data: {\"id\":\"e2\",\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_abc123\",\"status\":{\"type\":\"busy\"}}}\n\n"
	for version, silentAPI := range map[string]bool{"1.19.5": true, "2.2.4": false} {
		t.Run(version, func(t *testing.T) {
			cfg, _ := stubConfig(t)
			cfg.Version = version
			path := filepath.Join(t.TempDir(), "frames")
			require.NoError(t, os.WriteFile(path, []byte(frames), 0o600))
			t.Setenv(eventsFileVar, path)
			if silentAPI {
				t.Setenv("STANDIN_SILENT_API_EVENT", "1")
			}
			m := NewManager(cfg)
			defer m.Close()
			_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
			require.NoError(t, err)
			waitFor(t, "the turn to be working", func() bool { s, _, ok := m.AgentTurn("agent-1"); return ok && s == StateWorking })
		})
	}
}

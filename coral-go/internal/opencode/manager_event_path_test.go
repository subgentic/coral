package opencode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// On the real 1.19.5 a turn's busy and idle come on /event; /api/event carries only message and session updates. A 1.x server's state is read from /event, a 2.x server's from /api/event (found by the end-to-end
// run: the dot never moved and no chat or last message appeared, #137997).
func TestAnAgentsStateIsReadFromTheEventStreamItsVersionPutsItOn(t *testing.T) {
	assert.Equal(t, "/global/event", EventPath(1))
	assert.Equal(t, "/api/event", EventPath(2))
	assert.Equal(t, "/api/event", EventPath(3))
	// what each build really sends: 1.19.5 on /global/event wraps every event with its folder; 2.x's /api/event frames are the event itself
	wrapped := "data: {\"payload\":{\"id\":\"e1\",\"type\":\"server.connected\",\"properties\":{}}}\n\n" +
		"data: {\"directory\":\"/work/agent\",\"project\":\"global\",\"payload\":{\"id\":\"e2\",\"type\":\"sync\",\"syncEvent\":{\"type\":\"message.updated.1\"}}}\n\n" +
		"data: {\"directory\":\"/work/agent\",\"project\":\"global\",\"payload\":{\"id\":\"e3\",\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_abc123\",\"status\":{\"type\":\"busy\"}}}}\n\n"
	plain := "data: {\"id\":\"e1\",\"type\":\"server.connected\",\"properties\":{}}\n\n" +
		"data: {\"id\":\"e2\",\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_abc123\",\"status\":{\"type\":\"busy\"}}}\n\n"
	frames := map[string]string{"1.19.5": wrapped, "2.2.4": plain}
	for version, silentAPI := range map[string]bool{"1.19.5": true, "2.2.4": false} {
		t.Run(version, func(t *testing.T) {
			cfg, _ := stubConfig(t)
			cfg.Version = version
			path := filepath.Join(t.TempDir(), "frames")
			require.NoError(t, os.WriteFile(path, []byte(frames[version]), 0o600))
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

// The frames 1.19.5 really sends on /global/event (captured on the real build), each wrapped with its folder.
func TestTheGlobalStreamsWrappedFramesAreRead(t *testing.T) {
	real := "data: {\"payload\":{\"id\":\"evt_1\",\"type\":\"server.connected\",\"properties\":{}}}\n\n" +
		"data: {\"directory\":\"/w\",\"project\":\"global\",\"payload\":{\"id\":\"evt_2\",\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_e70b63919ffext2A1clnJu2a7d\",\"status\":{\"type\":\"busy\"}}}}\n\n" +
		"data: {\"directory\":\"/w\",\"project\":\"global\",\"payload\":{\"id\":\"evt_3\",\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_e70b63919ffext2A1clnJu2a7d\"}}}\n\n"
	var got []Event
	require.NoError(t, ParseStream(context.Background(), strings.NewReader(real), func(e Event) { got = append(got, e) }))
	require.Len(t, got, 3)
	assert.Equal(t, Event{Type: "session.status", SessionID: "ses_e70b63919ffext2A1clnJu2a7d", Status: "busy"}, got[1])
	st, ok := StateOf(got[1])
	assert.True(t, ok)
	assert.Equal(t, StateWorking, st)
	st, ok = StateOf(got[2])
	assert.True(t, ok)
	assert.Equal(t, StateIdle, st)
}

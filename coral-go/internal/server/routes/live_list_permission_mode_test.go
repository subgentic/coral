package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #10253 (the desktop tester): the empty chat said "Auto mode: everything, with safety checks" for an agent launched in Default, because the live row carried no permission mode and the page guessed Auto. The row carries the
// launch's effective permission_mode (Default, Plan, Accept edits, Auto...) as it was stored, and no key at all when none is on record, so the page says nothing rather than something false.
func TestLiveListRowsCarryTheLaunchsPermissionMode(t *testing.T) {
	server, _, terminal, ss := setupSessionsTestServer(t)
	defer server.Close()
	mode := func(s string) *string { return &s }
	want := map[string]*string{
		"00000000-0000-0000-0000-0000001025a1": mode("default"),
		"00000000-0000-0000-0000-0000001025a2": mode("plan"),
		"00000000-0000-0000-0000-0000001025a3": mode("auto"),
		"00000000-0000-0000-0000-0000001025a4": nil, // launched before the mode was stored: nothing on record
	}
	for sid, m := range want {
		terminal.addSession("claude-"+sid, "/tmp/w")
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "w" + sid[len(sid)-2:], WorkingDir: "/tmp/w", CreatedAt: time.Now().UTC().Format(time.RFC3339), PermissionMode: m}))
	}
	resp, err := http.Get(server.URL + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	var rows []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
	got := map[string]any{}
	for _, r := range rows {
		sid, _ := r["session_id"].(string)
		if _, ok := want[sid]; ok {
			got[sid] = r["permission_mode"]
		}
	}
	require.Len(t, got, 4)
	for sid, m := range want {
		if m == nil {
			assert.Nil(t, got[sid], "no mode on record: no permission_mode on the row (%s)", sid)
			continue
		}
		assert.Equal(t, *m, got[sid], sid)
	}
}

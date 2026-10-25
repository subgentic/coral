package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/redact"
)

// The operator's decision of 2026-10-24 (via coral-hub): a Coral Hub viewer at View sees everything the computer's own dashboard sees, except secrets (redacted) and writes (refused). This reverses #6592 ("a
// view-only viewer does not see commands") and #7116's counts-only rule. These are the nine keys the connector used to null: waiting_summary, held_messages, blocked_on, decision, recommendation, if_silent,
// goals_brief, goals_open and goals_seq. This test is the pin: a View viewer gets all nine with their values over HTTP and on the live feed, a token in the same reply is still redacted, and a write is
// still refused. If someone adds a mask again this fails; if someone removes the redaction, this fails.

const unmaskedKeys = `"waiting_summary":"Claude needs your permission to use Bash: rm -rf <dir>","held_messages":[{"id":"h1","text":"queued words"}],"blocked_on":"the Operator","decision":"pick a date","recommendation":"Friday","if_silent":"we ship Friday","goals_brief":{"team":{"open":2,"seq":9}},"goals_open":2,"goals_seq":9,"goal_events":[{"board":"team","goal":7,"kind":"goal_closed","seq":9}],"goal_events_gap":true`

func unmaskedBody(tok string) string {
	return `{"token":"` + tok + `",` + unmaskedKeys + `}`
}

func assertNineKeys(t *testing.T, body, tok, where string) {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &m), where+": "+body)
	for _, k := range []string{"waiting_summary", "held_messages", "blocked_on", "decision", "recommendation", "if_silent", "goals_brief", "goals_open", "goals_seq", "goal_events", "goal_events_gap"} { // the last two are the goal events of the feed (#7355): ids and kinds, nothing the connector masks
		assert.NotNil(t, m[k], where+": "+k+" has its value for a View viewer")
	}
	assert.Contains(t, body, "rm -rf <dir>", where)
	assert.Contains(t, body, "queued words", where)
	assert.Contains(t, body, "pick a date", where)
	assert.NotContains(t, body, tok, where+": the secret in the same reply is redacted")
	assert.Contains(t, body, redact.Marker, where)
}

func TestAViewViewerSeesEverythingButSecretsAndWritesAreRefused(t *testing.T) {
	tok := fake("ghp_", 36, alnum)
	var writes atomic.Int32
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes.Add(1)
		}
		if r.URL.Path == "/ws/coral" {
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer c.CloseNow()
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"type":"coral_update","token":"`+tok+`",`+unmaskedKeys+`}`))
			_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"type":"coral_diff","token":"`+tok+`",`+unmaskedKeys+`}`))
			c.Read(r.Context())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, unmaskedBody(tok))
	})
	var mode atomic.Int32
	mode.Store(int32(TierLaunch))
	cur := func() Mode { return Mode(mode.Load()) }
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.MaxMode = cur
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(cur)
		l.RedactTokens = func() bool { return true } // the owner's switch is on: secrets stay out, everything else is in
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	viewCtx := WithHubTier(WithHubUser(ctx, "hub-user-1234abcd"), "view")

	// Every route the connector used to rewrite, as a View viewer.
	for _, path := range []string{"/api/sessions/live", "/api/sessions/s1/resolve", "/api/sessions/s1/status", "/api/board/team/goals", "/api/board/team/goals/3", "/api/board/projects", "/api/goals"} {
		req, _ := http.NewRequestWithContext(viewCtx, http.MethodGet, "http://x"+path, nil)
		resp, err := sess.RoundTrip(req)
		require.NoError(t, err, path)
		b, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		require.NoError(t, err, path)
		require.Equal(t, 200, resp.StatusCode, path)
		assertNineKeys(t, string(b), tok, path)
	}

	// The live feed: the first update and a later diff, both as a View viewer.
	c, err := sess.DialWS(viewCtx, "/ws/coral", "", nil)
	require.NoError(t, err)
	defer c.CloseNow()
	for i, kind := range []string{"coral_update", "coral_diff"} {
		_, data, err := c.Read(ctx)
		require.NoError(t, err)
		assert.Contains(t, string(data), kind)
		assertNineKeys(t, string(data), tok, "the live feed frame "+strings.Repeat("+", i))
	}

	// Read-only is kept, by the connector itself (the viewer-tier gate, #7076) and by the computer's mode. First the viewer's own tier: the computer's mode is Launch, the viewer is View, the hub's
	// check is not in this harness, and a write still never reaches the computer.
	before := writes.Load()
	for _, path := range []string{"/api/board/team/goals", "/api/sessions/live/a/send", "/api/board/team/tasks"} {
		req, _ := http.NewRequestWithContext(viewCtx, http.MethodPost, "http://x"+path, strings.NewReader(`{"title":"x"}`))
		_, err := sess.RoundTrip(req)
		require.Error(t, err, path+": a View viewer's write is refused by the connector while the computer's mode is Launch")
		assert.Contains(t, err.Error(), "path_not_allowed", path)
	}
	assert.Equal(t, before, writes.Load(), "no write reached the computer")
	// Then the computer's mode: lowered to View, it holds a viewer of any tier.
	mode.Store(int32(TierView))
	before = writes.Load()
	for _, path := range []string{"/api/board/team/goals", "/api/sessions/live/a/send", "/api/board/team/tasks"} {
		req, _ := http.NewRequestWithContext(viewCtx, http.MethodPost, "http://x"+path, strings.NewReader(`{"title":"x"}`))
		resp, err := sess.RoundTrip(req)
		require.Error(t, err, path+": a write is refused while the computer's mode is View")
		assert.Contains(t, err.Error(), "local_mode", path)
		_ = resp
	}
	assert.Equal(t, before, writes.Load(), "no write reached the computer")
	req, _ := http.NewRequestWithContext(viewCtx, http.MethodGet, "http://x/api/sessions/live", nil)
	resp, err := sess.RoundTrip(req)
	require.NoError(t, err)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assertNineKeys(t, string(b), tok, "a read at View mode")
}

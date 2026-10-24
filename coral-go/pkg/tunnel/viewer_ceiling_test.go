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
)

// #7076 (stage 0 of #7074's note): the connector holds a viewer to the LOWER of its own tier and the computer's mode, for requests and for terminal frames. Before, only the computer's mode
// was checked and the viewer's tier only redacted, so "a View viewer never sends input" was the hub's promise alone.
func TestViewerCeilingTable(t *testing.T) {
	for in, want := range map[string]Mode{
		"": TierLaunch, "view": TierView, "interact": TierInteract, "launch": TierLaunch,
		"Launch": TierView, "LAUNCH": TierView, " launch": TierView, "admin": TierView, "never": TierView, "view,launch": TierView,
	} {
		assert.Equal(t, want, viewerCeiling(Header{HubTier: in}), "%q", in)
	}
}

func TestViewerTierCapsRequestsAndTerminalFrames(t *testing.T) {
	hub := newHub(t, fastCfg())
	fc := &fakeCoral{}
	var mode atomic.Int32
	mode.Store(int32(TierLaunch)) // the computer allows everything: only the viewer's tier is in the way
	cur := func() Mode { return Mode(mode.Load()) }
	sess, _ := connect(t, hub, fc.handler(), func(l *LocalHandler) {
		l.AllowRequest = AllowRequest(cur)
		l.MaxMode = cur
	})
	call := func(tier, method, path string) (ok bool, err error) {
		t.Helper()
		ctx := context.Background()
		if tier != "" {
			ctx = WithHubTier(ctx, tier)
		}
		req, _ := http.NewRequestWithContext(ctx, method, "http://x"+path, strings.NewReader("{}"))
		resp, err := sess.RoundTrip(req)
		if err != nil {
			return false, err
		}
		resp.Body.Close()
		return resp.StatusCode == 200, nil
	}
	input := []string{"/api/sessions/live/a/send", "/api/sessions/live/a/keys", "/api/sessions/live/a/resize", "/api/sessions/live/a/answer-prompt"}
	for _, p := range input {
		ok, err := call("view", "POST", p)
		require.Error(t, err, "View: %s is refused", p)
		assert.Contains(t, err.Error(), "path_not_allowed", p)
		assert.False(t, ok)
		for _, tier := range []string{"interact", "launch", ""} { // "" is a hub that names no tier: held only by the computer's mode, as before
			ok, err := call(tier, "POST", p)
			require.NoError(t, err, "%q: %s", tier, p)
			assert.True(t, ok, "%q: %s", tier, p)
		}
	}
	// A reply that only looks stays open to every tier, and the feed's read at Interact (coral-hub's live list) passes.
	for _, tier := range []string{"view", "interact", "launch", ""} {
		ok, err := call(tier, "GET", "/api/sessions/live")
		require.NoError(t, err, tier)
		assert.True(t, ok, tier)
	}
	// Interact cannot start things; Launch can.
	_, err := call("interact", "POST", "/api/sessions/launch")
	require.Error(t, err)
	ok, err := call("launch", "POST", "/api/sessions/launch")
	require.NoError(t, err)
	assert.True(t, ok)
	// And the computer's mode still caps the viewer: Launch on a View computer sends nothing.
	mode.Store(int32(TierView))
	_, err = call("launch", "POST", "/api/sessions/live/a/send")
	require.Error(t, err)
	mode.Store(int32(TierLaunch))
	for _, p := range fc.seenPaths() {
		assert.NotContains(t, p, "/api/sessions/live/a/send?view", "no refused request reached Coral")
	}

	// Terminal: output is View, but a View viewer's input frame closes the stream and never reaches the terminal, on a computer that allows input.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	in, _ := json.Marshal(map[string]string{"type": "terminal_input", "data": "rm -rf ~\n"})
	ws, err := sess.DialWS(WithHubTier(ctx, "view"), "/ws/terminal/a", "", nil)
	require.NoError(t, err)
	defer ws.CloseNow()
	_, out, err := ws.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, "prompt$ ", string(out), "View reads the terminal")
	before := len(fc.seenInputs())
	require.NoError(t, ws.Write(ctx, websocket.MessageText, in))
	_, _, err = ws.Read(ctx)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err), "View input closes the stream")
	time.Sleep(100 * time.Millisecond)
	assert.Len(t, fc.seenInputs(), before, "View input never reached the local terminal")
	// A heartbeat is not input: View keeps its stream.
	ws3, err := sess.DialWS(WithHubTier(ctx, "view"), "/ws/terminal/a", "", nil)
	require.NoError(t, err)
	defer ws3.CloseNow()
	_, _, _ = ws3.Read(ctx)
	require.NoError(t, ws3.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)))
	// Interact, and a hub that names no tier, type as before.
	for _, tier := range []string{"interact", ""} {
		c := ctx
		if tier != "" {
			c = WithHubTier(ctx, tier)
		}
		w, err := sess.DialWS(c, "/ws/terminal/a", "", nil)
		require.NoError(t, err, tier)
		_, _, _ = w.Read(ctx)
		n := len(fc.seenInputs())
		ok, _ := json.Marshal(map[string]string{"type": "terminal_input", "data": "ls\n"})
		require.NoError(t, w.Write(ctx, websocket.MessageText, ok), tier)
		require.Eventually(t, func() bool { return len(fc.seenInputs()) == n+1 }, 3*time.Second, 10*time.Millisecond, "%q types", tier)
		w.CloseNow()
	}
}

// coral-hub's feed reads /ws/coral at Interact on purpose (no input, no writes), and a View viewer's frames on it (a ping, a subscribe) are not terminal input: both open and flow under the new gate.
func TestViewerTierLeavesTheLiveFeedSocketOpen(t *testing.T) {
	hub := newHub(t, fastCfg())
	var mode atomic.Int32
	mode.Store(int32(TierLaunch))
	cur := func() Mode { return Mode(mode.Load()) }
	got := make(chan string, 4)
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/coral" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"type":"snapshot"}`))
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			got <- string(b)
		}
	})
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.AllowRequest = AllowRequest(cur)
		l.MaxMode = cur
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, tier := range []string{"view", "interact", "launch", ""} {
		c := ctx
		if tier != "" {
			c = WithHubTier(ctx, tier)
		}
		w, err := sess.DialWS(c, "/ws/coral", "", nil)
		require.NoError(t, err, tier)
		_, b, err := w.Read(ctx)
		require.NoError(t, err, tier)
		assert.Equal(t, `{"type":"snapshot"}`, string(b), tier)
		require.NoError(t, w.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)), tier)
		select {
		case m := <-got:
			assert.Equal(t, `{"type":"ping"}`, m, tier)
		case <-time.After(3 * time.Second):
			t.Fatalf("%q: the frame did not reach the feed", tier)
		}
		w.CloseNow()
	}
}

// viewerMayUse (#7278, QA's #7274 note 4): a route that is not in the table (Never) is refused for a viewer below Launch, whatever it asks; at Launch the computer's mode (AllowRequest) is what refuses it. The
// Never clause matters because TierNever is the lowest value: without it, "no higher than the ceiling" would let every unlisted route through.
func TestViewerMayUseRefusesANeverRouteBelowLaunch(t *testing.T) {
	require.Equal(t, TierNever, Classify("POST", "/api/not-a-route", ""), "the probe route is not in the table")
	require.Equal(t, TierNever, Classify("GET", "/api/settings", ""))
	for _, c := range []struct{ method, path string }{{"POST", "/api/not-a-route"}, {"GET", "/api/settings"}, {"DELETE", "/api/anything-else"}} {
		for _, tier := range []string{"view", "interact", "Interact", "bogus"} {
			assert.False(t, viewerMayUse(Header{HubTier: tier}, c.method, c.path), "%s %s at %q", c.method, c.path, tier)
		}
	}
	assert.True(t, viewerMayUse(Header{HubTier: "view"}, "GET", "/api/sessions/live"), "a read is open to View")
	assert.False(t, viewerMayUse(Header{HubTier: "view"}, "POST", "/api/sessions/live/a/send"), "an input is not")
	assert.True(t, viewerMayUse(Header{HubTier: "interact"}, "POST", "/api/sessions/live/a/send"))
}

// A hub that sends a tier spelled wrong (an embedder that passes the raw value) is held as View end to end: requests, the terminal's input frames and redaction, through a real session (#7278).
func TestAWronglySpelledTierIsHeldAsViewEverywhere(t *testing.T) {
	tok := fake("ghp_", 36, alnum)
	hub := newHub(t, fastCfg())
	fc := &fakeCoral{}
	inner := fc.handler()
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sessions/live/a/capture" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"output":"token ` + tok + ` here"}`))
			return
		}
		inner.ServeHTTP(w, r)
	})
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.AllowRequest = AllowRequest(func() Mode { return TierLaunch })
		l.MaxMode = func() Mode { return TierLaunch }
		l.RedactTokens = func() bool { return true }
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	in, _ := json.Marshal(map[string]string{"type": "terminal_input", "data": "rm -rf ~\n"})
	for _, bad := range []string{"Launch", "LAUNCH", " launch", "admin"} {
		c := WithHubTier(ctx, bad)
		// the request gate
		req, _ := http.NewRequestWithContext(c, "POST", "http://x/api/sessions/live/a/send", strings.NewReader("{}"))
		_, err := sess.RoundTrip(req)
		require.Error(t, err, "%q: an input request is refused", bad)
		assert.Contains(t, err.Error(), "path_not_allowed", bad)
		// redaction
		req, _ = http.NewRequestWithContext(c, "GET", "http://x/api/sessions/live/a/capture", nil)
		resp, err := sess.RoundTrip(req)
		require.NoError(t, err, bad)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		assert.NotContains(t, string(b), tok, "%q: redacted like a View viewer", bad)
		// the frame gate
		before := len(fc.seenInputs())
		ws, err := sess.DialWS(c, "/ws/terminal/a", "", nil)
		require.NoError(t, err, bad)
		_, _, _ = ws.Read(ctx)
		require.NoError(t, ws.Write(ctx, websocket.MessageText, in), bad)
		_, _, err = ws.Read(ctx)
		require.Error(t, err, bad)
		assert.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err), "%q: input closes the stream", bad)
		ws.CloseNow()
		time.Sleep(50 * time.Millisecond)
		assert.Len(t, fc.seenInputs(), before, "%q: no input reached the terminal", bad)
	}
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/redact"
)

// keyLinkWorld is one Coral (its own data folder, a real listening server) with the key links' tunnels running and no hosted Hub: a computer a self-hosted Hub set up.
type keyLinkWorld struct {
	r  *e2eRemote
	cs *store.CloudStore
	m  *cloud.Manager
	h  http.Handler
}

func newKeyLinkWorld(t *testing.T) *keyLinkWorld {
	t.Helper()
	r := newE2ERemote(t, "k", nil)
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.dir))
	local := httptest.NewServer(r.srv.Router()) // the bridge's own calls are this computer's loopback, as in production (the remote's front door marks every caller as another computer)
	t.Cleanup(local.Close)
	m := cloud.New(cloud.Options{Store: cs, LocalBaseURL: local.URL, Redactor: secrets.Redactor(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.RunKeyLinks(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	r.srv.cloudHandler.SetManager(m)
	_, err := r.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	return &keyLinkWorld{r: r, cs: cs, m: m, h: r.srv.Router()}
}

// join runs the whole join as a self-hosted Hub does it: a key, the request, the person's Allow at this computer, and the finish as a key link.
func (w *keyLinkWorld) join(t *testing.T, hub, asked, given string) (keyID, key string, l *store.CloudLink) {
	t.Helper()
	keyID, key = makeKeyForTest(t, w.h, strings.TrimPrefix(hub, "https://"))
	kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}
	rec := call(w.h, "POST", "/api/cloud/link-requests", `{"hub":"`+hub+`","cap":"`+asked+`"}`, kj)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var made map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &made))
	id, _ := made["request_id"].(string)
	secret, _ := made["poll_secret"].(string)
	al := call(w.h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"`+given+`"}`, map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, al.Code, al.Body.String())
	code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, code, 2)
	fin := call(w.h, "POST", "/api/cloud/link-requests/"+id+"/finish", `{"poll_secret":"`+secret+`","code":"`+code[1]+`","link":"key"}`, kj)
	require.Equal(t, 200, fin.Code, fin.Body.String())
	assert.JSONEq(t, `{"linked":true,"cap":"`+given+`"}`, fin.Body.String(), "the answer is only the link and its cap")
	l, err := w.cs.KeyLink(context.Background(), keyID)
	require.NoError(t, err)
	return keyID, key, l
}

// sendBody is send with a body.
func (w *keyLinkWorld) sendBody(t *testing.T, method, path, key, body string, hdr map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, w.r.url()+path, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set(linkKeyHeader, key)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// get sends a request to the real server with the key alone, as the Hub's proxy does.
func (w *keyLinkWorld) send(t *testing.T, method, path, key string, hdr map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, w.r.url()+path, nil)
	require.NoError(t, err)
	req.Header.Set(linkKeyHeader, key)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// #21220, design (B): a self-hosted Hub's key, once its request is Allowed and finished as a key link, reaches this computer at the link's cap through the same route table as a tunnel link; Operator-only routes
// never; a stamp is refused (#21261); removing the link puts the key back to its three join calls; revoking the key ends it.
func TestAKeyLinkReachesThisComputerAtItsCapAndEndsWithTheLinkOrTheKey(t *testing.T) {
	w := newKeyLinkWorld(t)
	keyID, key, l := w.join(t, "https://hub-b.example.com", "interact", "view")
	assert.Equal(t, "view", l.MaxMode)

	ok := func() bool { code, _ := w.send(t, "GET", "/api/health", key, nil); return code == 200 }
	require.Eventually(t, ok, 5*time.Second, 20*time.Millisecond, "the link's tunnel opens")
	code, _ := w.send(t, "GET", "/api/sessions/live", key, nil)
	assert.Equal(t, 200, code, "a View read")
	code, _ = w.send(t, "GET", "/api/settings", key, nil)
	assert.Equal(t, 403, code, "an Operator-only route is never a Hub's")
	code, _ = w.send(t, "POST", "/api/sessions/launch", key, map[string]string{"Content-Type": "application/json"})
	assert.Equal(t, 403, code, "above the link's cap")
	code, body := w.send(t, "GET", "/api/sessions/live", key, map[string]string{"X-Coral-Hub-Owner": "v1.1." + strings.Repeat("0", 32) + "." + strings.Repeat("0", 64)})
	assert.Equal(t, 403, code)
	assert.Contains(t, body, "#21261", "a stamp is refused with a plain reason, never ignored")
	code, _ = w.send(t, "GET", "/api/health", "lrk_00000000_"+strings.Repeat("0", 32), nil)
	assert.Equal(t, 401, code, "a wrong key")

	// removed: the key is back to its three join calls
	rm := call(w.h, "DELETE", "/api/cloud/links/"+l.LinkID, "", map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, rm.Code, rm.Body.String())
	require.Eventually(t, func() bool { code, _ := w.send(t, "GET", "/api/health", key, nil); return code == 403 }, 5*time.Second, 20*time.Millisecond)
	_, body = w.send(t, "GET", "/api/health", key, nil)
	assert.Contains(t, body, "link_key_scope")

	// a second key link, then its key revoked: 401 at once, and the link shows as revoked
	keyID2, key2, l2 := w.join(t, "https://hub-c.example.com", "view", "view")
	require.Eventually(t, func() bool { code, _ := w.send(t, "GET", "/api/health", key2, nil); return code == 200 }, 5*time.Second, 20*time.Millisecond)
	require.Equal(t, 200, call(w.h, "DELETE", "/api/cloud/link-keys/"+keyID2, "", map[string]string{"Content-Type": "application/json"}).Code)
	code, _ = w.send(t, "GET", "/api/health", key2, nil)
	assert.Equal(t, 401, code)
	got, err := w.cs.LinkByOrigin(context.Background(), l2.HubOrigin)
	require.NoError(t, err)
	assert.Equal(t, store.LinkStateRevoked, got.State)
	_ = keyID
}

// Security's MUST 3 on #21220: lowering a key link's cap ends the streams its key holds open within seconds, not only the next request. And Security's round 1 MUST: at Interact a key link is
// still never the person: typing into the agent (Send, Keys, a terminal frame) and answering its prompt are refused, and so are the person-only reads; the stream itself stays open to watch.
func TestLoweringAKeyLinksCapEndsItsOpenTerminalStream(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the terminal is a /bin/sh shell here")
	}
	w := newKeyLinkWorld(t)
	_, key, l := w.join(t, "https://hub-d.example.com", "interact", "interact")
	require.Eventually(t, func() bool { code, _ := w.send(t, "GET", "/api/health", key, nil); return code == 200 }, 5*time.Second, 20*time.Millisecond)
	sid := w.r.launchDirectTerminal(t, w.r.work)
	sname := w.r.sessionNameFor(sid)
	require.NotEmpty(t, sname)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(w.r.url(), "http") + "/ws/terminal/" + sname + "?agent_type=terminal&session_id=" + sid
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{linkKeyHeader: {key}}})
	require.NoError(t, err)
	defer c.CloseNow()
	require.NoError(t, wsjson.Write(ctx, c, map[string]any{"type": "terminal_input", "data": "echo key-link-$((40+2))\n", "id": 7}))
	for {
		typ, data, err := c.Read(ctx)
		require.NoError(t, err)
		if typ == websocket.MessageText && strings.Contains(string(data), `"id":7`) {
			assert.Contains(t, string(data), "terminal_input_failed")
			assert.Contains(t, string(data), "key_link_person_act", "typed by a key link: refused, never typed")
			break
		}
	}
	jsonHdr := map[string]string{"Content-Type": "application/json"}
	for _, p := range []string{"/send", "/keys", "/answer-prompt"} {
		code, body := w.sendBody(t, "POST", "/api/sessions/live/"+sname+p, key, `{"command":"echo hi","keys":["Enter"],"answer":"1","session_id":"`+sid+`"}`, jsonHdr)
		assert.Equal(t, 403, code, "%s through a key link: %s", p, body)
		assert.Contains(t, body, "key_link_person_act", p)
	}
	for _, p := range []string{"/api/operator-asks", "/api/needs-you"} {
		code, body := w.send(t, "GET", p, key, nil)
		assert.NotEqual(t, 200, code, "a person-only read through a key link: %s", body)
	}

	rec := call(w.h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"view"}`, map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	ended := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				ended <- err
				return
			}
		}
	}()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the terminal stream stayed open after the key link's cap was lowered to View")
	}
}

// The Orchestrator's pin on #21220: a View key link's replies are redacted exactly as a hosted View link's are (the same LocalHandler and Redactor; hub_tier_e2e_test.go is the hosted side): a token in a file
// is the marker, never the token.
func TestAViewKeyLinkIsRedactedAsAHostedViewLinkIs(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	home, repo := filepath.Join(base, "home"), filepath.Join(base, "repo")
	require.NoError(t, os.MkdirAll(home, 0o755))
	setHome(t, home)
	t.Setenv("CORAL_PROJECT_ROOTS", "")
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "app"), 0o755))
	require.NoError(t, exec.Command("git", "init", "-q", repo).Run())
	tok := "ghp_" + strings.Repeat("aB3dE6gH9k", 4)[:36]
	require.NoError(t, os.WriteFile(filepath.Join(repo, "app", "notes.txt"), []byte("token "+tok+" here\n"), 0o644))

	w := newKeyLinkWorld(t)
	require.NoError(t, store.NewSessionStore(w.r.db).RegisterLiveSession(context.Background(), &store.LiveSession{
		AgentName: "claude-tier", AgentType: "claude", WorkingDir: filepath.Join(repo, "app"), SessionID: "tier-1"}))
	_, key, _ := w.join(t, "https://hub-e.example.com", "view", "view")
	require.Eventually(t, func() bool { code, _ := w.send(t, "GET", "/api/health", key, nil); return code == 200 }, 5*time.Second, 20*time.Millisecond)
	code, body := w.send(t, "GET", "/api/sessions/live/claude-tier/file-content?session_id=tier-1&filepath=app/notes.txt", key, nil)
	require.Equal(t, 200, code, body)
	assert.NotContains(t, body, tok)
	assert.Contains(t, body, redact.Marker)
}

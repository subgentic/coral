package routes

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/gdocsync"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// #19996 (goal #265): sharing an artifact to a Google Doc is an experimental feature, off for every install. Slice 1: the switch, its refusal and the status route.
func TestGdocShareIsOffByDefaultRefusesWhileOffAndReportsItsState(t *testing.T) {
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	oldConn := gdocConnected
	gdocConnected = func() bool { return false } // never the real keychain in a test
	t.Cleanup(func() { gdocConnected = oldConn })
	r := chi.NewRouter()
	h.RegisterGdocShare(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()

	get := func() (int, map[string]any) {
		resp, err := http.Get(srv.URL + "/api/gdoc/status")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	assert.False(t, setreg.Bool(map[string]string{}, setreg.GdocShare), "off for every install")
	status, out := get()
	assert.Equal(t, 200, status, "%v", out)
	assert.Equal(t, false, out["enabled"], "the status route answers while off, and says off")

	// every other route of the feature is refused while off, with the message that names the setting
	resp, err := http.Post(srv.URL+"/api/artifacts/abc/gdoc/share", "application/json", nil)
	require.NoError(t, err)
	var refused map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&refused)
	resp.Body.Close()
	assert.Equal(t, 403, resp.StatusCode, "%v", refused)
	assert.Equal(t, GdocShareOffMessage, refused["error"])
	assert.Contains(t, GdocShareOffMessage, "Share to Google (experimental)")

	require.NoError(t, ss.SetSetting(ctx, setreg.GdocShare, "true"))
	_, out = get()
	assert.Equal(t, true, out["enabled"])
	for k := range out {
		assert.NotContains(t, []string{"token", "access_token", "refresh_token", "client_secret"}, k, "the status never carries a credential")
	}
}

// A stand-in for Drive and Docs: it records what the share sent and answers like the real one in shape only. No call leaves the test.
type gdocStandIn struct {
	mu         sync.Mutex
	uploads    []string // the Markdown of each files.create
	titles     []string
	paras      []gdocsync.Para
	batches    int
	requests   int
	fail       int // answer this many requests with failStatus and a body that holds a secret
	failStatus int
}

func (g *gdocStandIn) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.fail > 0 {
		g.fail--
		http.Error(w, "backend error tok-SECRET-123", g.failStatus)
		return
	}
	switch {
	case r.Method == "POST" && r.URL.Path == "/upload/drive/v3/files":
		mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if !strings.HasPrefix(mt, "multipart/") {
			http.Error(w, "need multipart", 400)
			return
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(part)
			if strings.HasPrefix(part.Header.Get("Content-Type"), "application/json") {
				var m map[string]string
				_ = json.Unmarshal(b, &m)
				g.titles = append(g.titles, m["name"])
			} else {
				g.uploads = append(g.uploads, string(b))
				g.paras = gdocsync.ParseMarkdown(string(b))
			}
		}
		_, _ = w.Write([]byte(`{"id":"doc1"}`))
	case r.Method == "GET" && r.URL.Path == "/v1/documents/doc1":
		var content []map[string]any
		pos := 1
		for _, p := range g.paras {
			n := len(utf16.Encode([]rune(p.Text))) + 1
			para := map[string]any{"elements": []map[string]any{{"textRun": map[string]any{"content": p.Text + "\n"}}}, "paragraphStyle": map[string]any{"namedStyleType": p.Style}}
			if p.Bullet {
				para["bullet"] = map[string]any{}
			}
			content = append(content, map[string]any{"startIndex": pos, "endIndex": pos + n, "paragraph": para})
			pos += n
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"revisionId": "rev1", "body": map[string]any{"content": content}})
	case r.Method == "POST" && r.URL.Path == "/v1/documents/doc1:batchUpdate":
		var in struct {
			Requests []map[string]any `json:"requests"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		g.batches++
		g.requests += len(in.Requests)
		_, _ = w.Write([]byte(`{}`))
	default:
		http.Error(w, "no route "+r.URL.Path, 404)
	}
}

type gdocRig struct {
	srv   *httptest.Server
	h     *SessionsHandler
	ss    *store.SessionStore
	drive *gdocStandIn
}

func newGdocRig(t *testing.T, on bool) *gdocRig {
	t.Helper()
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	drive := &gdocStandIn{}
	ds := httptest.NewServer(drive)
	t.Cleanup(ds.Close)
	oldClient, oldMac, oldConn := gdocClientFor, gdocMac, gdocConnected
	gdocConnected = func() bool { return true }
	gdocClientFor = func() (*gdocsync.Client, error) {
		return gdocsync.NewClientAt(ds.URL, func() (string, error) { return "tok-SECRET-123", nil }), nil
	}
	gdocMac = func() bool { return true }
	t.Cleanup(func() { gdocClientFor, gdocMac, gdocConnected = oldClient, oldMac, oldConn })
	if on {
		require.NoError(t, ss.SetSetting(context.Background(), setreg.GdocShare, "true"))
	}
	r := chi.NewRouter()
	h.RegisterGdocShare(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &gdocRig{srv: srv, h: h, ss: ss, drive: drive}
}

func (g *gdocRig) artifact(t *testing.T, id, name, mediaType, body string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(g.h.artifactDir(), 0o755))
	meta, _ := json.Marshal(agentArtifactMeta{Name: name, MediaType: mediaType, Size: int64(len(body)), Digest: id})
	require.NoError(t, os.WriteFile(filepath.Join(g.h.artifactDir(), id+".json"), meta, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(g.h.artifactDir(), id), []byte(body), 0o644))
}

func (g *gdocRig) share(t *testing.T, id string) (int, map[string]any, string) {
	t.Helper()
	resp, err := http.Post(g.srv.URL+"/api/artifacts/"+id+"/gdoc/share", "application/json", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out, string(raw)
}

const (
	gdocV1 = "dd00000000000000000000000000000000000000000000000000000000000001"
	gdocV2 = "dd00000000000000000000000000000000000000000000000000000000000002"
	gdocTx = "dd00000000000000000000000000000000000000000000000000000000000003"
)

// #20008 (slice 2): the first share makes a Doc from the Markdown and keeps the link; the same artifact shared again changes only what differs, in the same Doc.
func TestSharingAMarkdownArtifactMakesADocAndAReshareChangesOnlyTheDifference(t *testing.T) {
	g := newGdocRig(t, true)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Friday.\n\nShip the build.\n")
	status, out, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	assert.Equal(t, true, out["created"])
	assert.Equal(t, "https://docs.google.com/document/d/doc1/edit", out["url"])
	require.Len(t, g.drive.uploads, 1)
	assert.Equal(t, []string{"plan.md"}, g.drive.titles)
	assert.NotContains(t, raw, "tok-SECRET-123", "the answer never carries the token")
	info, err := os.Stat(g.h.gdocLinksPath())
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "the link file is the owner's alone")

	// the same artifact again, nothing changed: no second Doc, no change sent
	status, out, raw = g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	assert.Equal(t, false, out["created"])
	assert.Len(t, g.drive.uploads, 1, "no second Doc")
	assert.Equal(t, 0, g.drive.batches, "an unchanged file sends nothing")
}

func TestAnArtifactThatIsNotMarkdownOrIsTooLargeIsRefusedBeforeAnyGoogleCall(t *testing.T) {
	g := newGdocRig(t, true)
	g.artifact(t, gdocTx, "shot.png", "image/png", "not markdown")
	status, out, _ := g.share(t, gdocTx)
	assert.Equal(t, 400, status)
	assert.Contains(t, out["error"], "Markdown")
	g.artifact(t, gdocV2, "big.md", "text/markdown", strings.Repeat("x", gdocMaxMarkdown+1))
	status, out, _ = g.share(t, gdocV2)
	assert.Equal(t, 400, status)
	assert.Contains(t, out["error"], "too large")
	assert.Empty(t, g.drive.uploads, "nothing reached Google")
}

func TestAGoogleFailureIsAnsweredInPlainWordsWithoutTheBodyAndLeavesNoLink(t *testing.T) {
	for status, code := range map[int]string{403: "gdoc_failed", 500: "gdoc_unknown"} { // a refusal is plain; a server error on a write may have been applied: look before sharing again
		g := newGdocRig(t, true)
		g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n")
		g.drive.fail, g.drive.failStatus = 1, status
		got, out, raw := g.share(t, gdocV1)
		assert.Equal(t, 502, got, raw)
		assert.NotContains(t, raw, "tok-SECRET-123", "neither the token nor Google's body is in the answer")
		assert.NotContains(t, raw, "backend error")
		assert.Equal(t, code, out["code"], "status %d", status)
		_, err := os.Stat(g.h.gdocLinksPath())
		assert.True(t, os.IsNotExist(err), "a failed share keeps no link")
	}
}

func TestSharingIsUnavailableOffAMacAndWhileTheSwitchIsOff(t *testing.T) {
	g := newGdocRig(t, true)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n")
	gdocMac = func() bool { return false }
	status, out, _ := g.share(t, gdocV1)
	assert.Equal(t, 501, status)
	assert.Equal(t, "gdoc_unavailable", out["code"])
	off := newGdocRig(t, false)
	off.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n")
	status, out, _ = off.share(t, gdocV1)
	assert.Equal(t, 403, status)
	assert.Equal(t, GdocShareOffMessage, out["error"])
	assert.Empty(t, off.drive.uploads)
}

// writeSeriesVersion records an artifact as version n of the series, the way an upload does, so the share finds the series.
func (g *gdocRig) writeSeriesVersion(t *testing.T, sid, digest string, n int) {
	t.Helper()
	dir := uploadsDir(g.h.cfg.CoralDir(), "s1")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	rec := agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Digest: digest}, CreatedAt: "2026-11-20T00:00:00Z", SeriesID: sid, Version: n}
	b, _ := json.Marshal(rec)
	require.NoError(t, os.WriteFile(filepath.Join(dir, digest+".json"), b, 0o600))
}

// The second version of a series goes to the same Doc and sends only the changed paragraph, not a new Doc and not the whole text.
func TestANewVersionOfASharedSeriesPatchesTheSameDocWithOnlyTheChange(t *testing.T) {
	g := newGdocRig(t, true)
	sid := strings.Repeat("a", 32)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Friday.\n\nShip the build.\n")
	g.artifact(t, gdocV2, "plan.md", "text/markdown", "# Plan\n\nThe launch is on Monday.\n\nShip the build.\n")
	g.writeSeriesVersion(t, sid, gdocV1, 1)
	g.writeSeriesVersion(t, sid, gdocV2, 2)

	status, out, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	assert.Equal(t, true, out["created"])
	status, out, raw = g.share(t, gdocV2)
	require.Equal(t, 200, status, raw)
	assert.Equal(t, false, out["created"], "the same Doc")
	assert.Len(t, g.drive.uploads, 1, "no second Doc")
	assert.Equal(t, 1, g.drive.batches, "one batchUpdate")
	assert.Greater(t, g.drive.requests, 0)
	assert.Less(t, g.drive.requests, 6, "only the changed paragraph is sent, not the whole text")
	links, err := g.h.loadGdocLinks()
	require.NoError(t, err)
	assert.Equal(t, gdocV2, links[sid].Digest, "the link remembers the version last sent")
}

func (g *gdocRig) status(t *testing.T, id string, hdr map[string]string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", g.srv.URL+"/api/gdoc/status?id="+id, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

// Slice A (#20010): the share dialog asks the status for the file: switch, sign-in kept, and (the Operator's alone) whether it is shared and where.
func TestTheStatusSaysIfAFileIsSharedAndWhereOnlyToTheOperator(t *testing.T) {
	g := newGdocRig(t, true)
	g.artifact(t, gdocV1, "plan.md", "text/markdown", "# Plan\n\nOne.\n")
	out := g.status(t, gdocV1, nil)
	assert.Equal(t, true, out["enabled"])
	assert.Equal(t, true, out["connected"])
	assert.Nil(t, out["shared"], "not shared yet")
	status, shared, raw := g.share(t, gdocV1)
	require.Equal(t, 200, status, raw)
	out = g.status(t, gdocV1, nil)
	assert.Equal(t, true, out["shared"])
	assert.Equal(t, shared["url"], out["url"])
	agent := g.status(t, gdocV1, map[string]string{"X-Coral-Session-Token": "an-agent-token"})
	assert.Nil(t, agent["shared"], "an agent is not told which Doc a file is in")
	assert.Nil(t, agent["url"])
}

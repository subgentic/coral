package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/hubdropbox"
)

type hdStubDropbox struct {
	got  [][]byte
	code int
	body string
}

func (f *hdStubDropbox) RoundTrip(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	f.got = append(f.got, b)
	code := f.code
	if code == 0 {
		code = 200
	}
	return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(f.body))}, nil
}

type hdEnv struct {
	d      *HubDropbox
	dir    string
	stub   *hdStubDropbox
	on     bool
	priv   bool
	intern bool
	readEr error
	now    time.Time
}

const hdLink = "https://content.dropboxapi.com/2/files/upload/CANARYLINKTOKEN"

func newHDEnv(t *testing.T) *hdEnv {
	e := &hdEnv{dir: t.TempDir(), stub: &hdStubDropbox{}, on: true, now: time.Unix(1_800_000_000, 0)}
	require.NoError(t, os.MkdirAll(filepath.Join(e.dir, "artifacts", "objects"), 0o700))
	e.d = &HubDropbox{
		CoralDir: e.dir,
		On:       func(context.Context) (bool, error) { return e.on, nil },
		Private:  func(context.Context, string) (bool, error) { return e.priv, e.readEr },
		Internal: func(context.Context, string) (bool, error) { return e.intern, e.readEr },
		Who:      func(string) (string, string, string) { return "notes.txt", "coral-go-team", "Lead Dev" },
		Client: func(g func(context.Context) (bool, error)) *hubdropbox.Uploader {
			return hubdropbox.NewUploaderWith(e.stub, g)
		},
		Now: func() time.Time { return e.now },
	}
	return e
}

func (e *hdEnv) put(t *testing.T, data string) string {
	s := sha256.Sum256([]byte(data))
	d := hex.EncodeToString(s[:])
	require.NoError(t, os.WriteFile(filepath.Join(e.dir, "artifacts", "objects", d), []byte(data), 0o600))
	return d
}

func (e *hdEnv) call(h http.HandlerFunc, body string) (int, string) {
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, req)
	return w.Code, strings.TrimSpace(w.Body.String())
}

func TestHubDropboxPrepare_OkHeldAndTheRefusals(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	code, body := e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.Equal(t, 200, code)
	assert.JSONEq(t, `{"word":"ok","size":11,"name":"notes.txt","project":"coral-go-team","agent":"Lead Dev"}`, body)

	for name, tc := range map[string]struct{ body, want string }{
		"missing object": {`{"digest":"` + strings.Repeat("a", 64) + `"}`, `{"word":"not_available"}`},
	} {
		_, got := e.call(e.d.Prepare, tc.body)
		assert.JSONEq(t, tc.want, got, name)
	}
	e.priv = true
	_, got := e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "private")
	e.priv, e.intern = false, true
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "internal tag")
	e.intern, e.readEr = false, errors.New("db locked")
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "unreadable mark fails closed")
	e.readEr = nil
	e.on = false
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"disabled"}`, got, "switch off")
}

func TestHubDropboxPrepare_BadNamesAreRefusedNotRepaired(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "x")
	for _, bad := range []string{"a/b.txt", ".hidden", "tab\there", "", strings.Repeat("n", 81), "a\\b", "\xff\xfe"} {
		e.d.Who = func(string) (string, string, string) { return bad, "proj", "agent" }
		_, got := e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
		assert.JSONEq(t, `{"word":"not_available"}`, got, "name %q", bad)
	}
}

const hdCanary = "Authorization: Bearer ghp_"

func canaryText() string { return "notes\n" + hdCanary + strings.Repeat("a", 36) + "\n" }

func TestHubDropbox_FlaggedIsHeldUntilTheOwnerClickAndTheClickIsUsedOnce(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, canaryText())
	_, got := e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"held"}`, got)
	_, got = e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"held"}`, got)
	assert.Empty(t, e.stub.got, "a held file sends nothing, not even a first chunk")

	e.d.AllowAnyway(d)
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.Contains(t, got, `"word":"ok"`)
	_, got = e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.Contains(t, got, `"word":"ok"`)
	require.Len(t, e.stub.got, 1)
	assert.Equal(t, canaryText(), string(e.stub.got[0]))

	_, got = e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"held"}`, got, "the click was used once")
	assert.Len(t, e.stub.got, 1)
}

func TestHubDropbox_TheClickExpiresAfterTenMinutes(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, canaryText())
	e.d.AllowAnyway(d)
	e.now = e.now.Add(10*time.Minute + time.Second)
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"held"}`, got)
	assert.Empty(t, e.stub.got)
}

func TestHubDropbox_ASecretSplitAcrossAChunkEdgeStillHoldsTheFile(t *testing.T) {
	e := newHDEnv(t)
	// the token starts 10 bytes before the 64 KiB read boundary and ends after it
	pad := strings.Repeat("x ", (64<<10-10)/2)
	d := e.put(t, pad+"Authorization: Bearer ghp_"+strings.Repeat("b", 36)+"\n")
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"held"}`, got)
	assert.Empty(t, e.stub.got)
}

func TestHubDropboxPush_SendsTheBytesAndReturnsTheHashes(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	code, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.Equal(t, 200, code)
	f, _ := hubdropbox.ReadOnce(strings.NewReader("plain notes"))
	assert.JSONEq(t, `{"word":"ok","content_hash":"`+f.ContentHash+`","size":11}`, got)
	require.Len(t, e.stub.got, 1)
	assert.Equal(t, "plain notes", string(e.stub.got[0]))
	assert.NotContains(t, got, "CANARYLINKTOKEN")
}

func TestHubDropboxPush_ABadLinkSendsNothing(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	for _, l := range []string{
		"http://content.dropboxapi.com/2/files/x",
		"https://evil.example/2/files/x",
		"https://content.dropboxapi.com/other/path",
		"https://content.dropboxapi.com/2/filesx",
		"https://content.dropboxapi.com:8443/2/files/x",
		"https://u:p@content.dropboxapi.com/2/files/x",
		"https://content.dropboxapi.com/2/files/../../x",
		"https://content.dropboxapi.com/2/files/x#f",
	} {
		_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+l+`"}`)
		assert.JSONEq(t, `{"word":"not_available"}`, got, l)
	}
	assert.Empty(t, e.stub.got)
}

func TestHubDropboxPush_TheFileChangedAfterPrepareIsNotSent(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "approved notes")
	_, got := e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	require.Contains(t, got, `"word":"ok"`)
	require.NoError(t, os.WriteFile(filepath.Join(e.dir, "artifacts", "objects", d), []byte(canaryText()), 0o600)) // edited in place
	_, got = e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"failed"}`, got)
	assert.Empty(t, e.stub.got, "bytes that are not the digest are never delivered")
}

func TestHubDropboxPush_AMarkSetBeforeTheSendStopsIt(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	calls := 0
	e.d.Private = func(context.Context, string) (bool, error) { calls++; return calls >= 2, nil } // clear at the first look, set at the one before the bytes
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got)
	assert.Empty(t, e.stub.got)
	assert.GreaterOrEqual(t, calls, 2, "the mark is read again right before the bytes go")
}

func TestHubDropboxPush_DropboxsAnswersMapToWords(t *testing.T) {
	for name, c := range map[string]struct {
		code int
		body string
		want string
	}{
		"space full": {409, `{"error_summary":"insufficient_space"}`, "quota_full"},
		"expired":    {410, "", "expired"},
		"limited":    {429, "", "rate_limited"},
		"other":      {500, "", "failed"},
		"other 409":  {409, `{"error_summary":"conflict"}`, "failed"},
	} {
		e := newHDEnv(t)
		e.stub.code, e.stub.body = c.code, c.body
		d := e.put(t, "plain notes")
		_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
		assert.JSONEq(t, `{"word":"`+c.want+`"}`, got, name)
	}
}

func TestHubDropbox_ClosedBodies(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "x")
	good := `"digest":"` + d + `"`
	for name, body := range map[string]string{
		"unknown key":  `{` + good + `,"extra":1}`,
		"repeated key": `{` + good + `,` + good + `}`,
		"missing":      `{}`,
		"wrong type":   `{"digest":5}`,
		"upper case":   `{"digest":"` + strings.ToUpper(d) + `"}`,
		"short":        `{"digest":"abc"}`,
		"trailing":     `{` + good + `}{}`,
		"array":        `[]`,
		"empty":        ``,
		"huge":         `{` + good + `,"pad":"` + strings.Repeat("a", 300) + `"}`,
	} {
		code, got := e.call(e.d.Prepare, body)
		assert.Equal(t, 400, code, name)
		assert.Equal(t, "{}", got, name)
	}
	req := httptest.NewRequest(http.MethodPost, "/x?a=1", strings.NewReader(`{`+good+`}`))
	w := httptest.NewRecorder()
	e.d.Prepare(w, req)
	assert.Equal(t, 400, w.Code, "a query string")
	for _, body := range []string{`{` + good + `,"link":"` + hdLink + `","x":1}`, `{` + good + `}`, `{` + good + `,"link":5}`} {
		code, _ := e.call(e.d.Push, body)
		assert.Equal(t, 400, code, body)
	}
	code, _ := e.call(e.d.SharedHint, `{`+good+`,"shared":"yes"}`)
	assert.Equal(t, 400, code)
}

func TestHubDropboxShared_RecordsAYesNoOnlyAndOnlyWhenOn(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "a shared file") // the hint is kept only for a digest of a real artifact (#16206)
	_, got := e.call(e.d.SharedHint, `{"digest":"`+d+`","shared":true}`)
	assert.JSONEq(t, `{"word":"ok"}`, got)
	assert.True(t, e.d.Shared(d))
	_, _ = e.call(e.d.SharedHint, `{"digest":"`+d+`","shared":false}`)
	assert.False(t, e.d.Shared(d))
	e.on = false
	_, got = e.call(e.d.SharedHint, `{"digest":"`+d+`","shared":true}`)
	assert.JSONEq(t, `{"word":"ok"}`, got)
	assert.False(t, e.d.Shared(d), "off: ok and nothing recorded")
}

func TestHubDropbox_OneAtATime(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	e.d.busy.Lock()
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"busy"}`, got)
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"busy"}`, got)
	e.d.busy.Unlock()
	assert.Empty(t, e.stub.got)
}

func TestHubDropbox_OffAnswersDisabledOnEveryRoute(t *testing.T) {
	e := newHDEnv(t)
	e.on = false
	d := e.put(t, "plain notes")
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"disabled"}`, got)
	assert.Empty(t, e.stub.got)
	e.d.On = nil
	_, got = e.call(e.d.Prepare, `{"digest":"`+d+`"}`)
	assert.JSONEq(t, `{"word":"disabled"}`, got, "no switch reader means off")
}

func TestHubDropbox_UnsetGateFailsClosed(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	e.d.Internal = nil
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got)
	assert.Empty(t, e.stub.got)
}

func TestHubDropbox_UploadAnywayNeedsTheSwitchAndAValidDigest(t *testing.T) {
	e := newHDEnv(t)
	call := func(dg string) int {
		rc := chi.NewRouteContext()
		rc.URLParams.Add("digest", dg)
		req := httptest.NewRequest(http.MethodPost, "/x", nil).WithContext(context.WithValue(context.Background(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		e.d.UploadAnyway(w, req)
		return w.Code
	}
	d := strings.Repeat("d", 64)
	assert.Equal(t, 200, call(d))
	assert.True(t, e.d.hasAnyway(d))
	assert.Equal(t, 400, call("nope"))
	e.on = false
	assert.Equal(t, 409, call(strings.Repeat("e", 64)))
	assert.False(t, e.d.hasAnyway(strings.Repeat("e", 64)))
}

// The route table marks the three Hub routes owner-only from the Hub: a request from this computer's own side is refused before the handler reads a byte (403 owner_only).
func TestHubDropbox_ALocalRequestOnTheRealPathsIsRefusedAsNotTheHubOwner(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	for path, h := range map[string]http.HandlerFunc{"/api/dropbox/prepare": e.d.Prepare, "/api/dropbox/push": e.d.Push, "/api/dropbox/shared": e.d.SharedHint} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"digest":"`+d+`","link":"`+hdLink+`","shared":true}`))
		w := httptest.NewRecorder()
		h(w, req)
		assert.Equal(t, http.StatusForbidden, w.Code, path)
		assert.Contains(t, w.Body.String(), "owner_only", path)
	}
	assert.Empty(t, e.stub.got)
}

type hdFuncRT func(*http.Request) (*http.Response, error)

func (f hdFuncRT) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// coral-hub's r4 question (#211112): when the Hub closes its call, the request's context is cancelled and the upload to Dropbox is aborted with it.
func TestHubDropboxPush_ACancelledHubCallAbortsTheUploadToDropbox(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	started := make(chan struct{})
	aborted := make(chan struct{})
	e.d.Client = func(g func(context.Context) (bool, error)) *hubdropbox.Uploader {
		return hubdropbox.NewUploaderWith(hdFuncRT(func(r *http.Request) (*http.Response, error) {
			io.ReadAll(r.Body)
			close(started)
			<-r.Context().Done() // a Dropbox that never answers
			close(aborted)
			return nil, r.Context().Err()
		}), g)
	}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"digest":"`+d+`","link":"`+hdLink+`"}`)).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { e.d.Push(w, req); close(done) }()
	<-started
	cancel() // the Hub closed the call
	select {
	case <-aborted:
	case <-time.After(5 * time.Second):
		t.Fatal("the upload to Dropbox was not aborted when the Hub's call was cancelled")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Push did not return after the Hub's call was cancelled")
	}
	assert.NotContains(t, w.Body.String(), "CANARYLINKTOKEN")
}

// Security's S3 on #16109, at the handler: a mark set while the stream runs never delivers the last 64 KiB to Dropbox.
func TestHubDropboxPush_AMarkSetDuringTheStreamNeverDeliversTheFinalChunk(t *testing.T) {
	e := newHDEnv(t)
	big := strings.Repeat("0123456789abcdef", 16<<10) // 256 KiB
	d := e.put(t, big)
	var received int
	e.d.Client = func(g func(context.Context) (bool, error)) *hubdropbox.Uploader {
		return hubdropbox.NewUploaderWith(hdFuncRT(func(r *http.Request) (*http.Response, error) {
			buf := make([]byte, 32<<10)
			for {
				n, err := r.Body.Read(buf)
				received += n
				if received >= 64<<10 {
					e.priv = true // the owner marks it private while the stream runs
				}
				if err == io.EOF {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				if err != nil {
					return nil, err
				}
			}
		}), g)
	}
	_, got := e.call(e.d.Push, `{"digest":"`+d+`","link":"`+hdLink+`"}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got)
	assert.LessOrEqual(t, received, len(big)-64<<10, "the last 64 KiB never reached Dropbox")
}

// The Share dialog's Hub view (#16109, coral-hub's differences #211076): Coral only opens the Hub's page, at the address in its enrolment record.
func TestHubDropboxShareView_OffersTheHubsPageFromTheEnrolmentOnly(t *testing.T) {
	e := newHDEnv(t)
	d := e.put(t, "plain notes")
	data := []byte("plain notes")
	e.d.Enrolment = func(context.Context) (string, string, error) {
		return "https://hub.example.test/some/path?x=1", "srv_1-A", nil
	}
	v := e.d.ShareView(t.Context(), d, data)
	assert.Equal(t, map[string]any{"offered": true, "url": "https://hub.example.test/dropbox/share/srv_1-A/" + d, "flagged": false}, v)

	assert.Equal(t, true, e.d.ShareView(t.Context(), d, []byte(canaryText()))["flagged"], "a file that looks like it holds a secret is flagged")

	e.on = false
	assert.Equal(t, map[string]any{"offered": false}, e.d.ShareView(t.Context(), d, data), "switch off: nothing offered")
	e.on = true

	e.intern = true
	assert.Equal(t, map[string]any{"offered": false, "blocked": "internal"}, e.d.ShareView(t.Context(), d, data))
	e.intern, e.readEr = false, errors.New("db locked")
	assert.Equal(t, map[string]any{"offered": false}, e.d.ShareView(t.Context(), d, data), "an unreadable tag offers nothing")
	e.readEr = nil

	for name, enrol := range map[string]func(context.Context) (string, string, error){
		"not enrolled":    func(context.Context) (string, string, error) { return "", "", errors.New("none") },
		"http hub":        func(context.Context) (string, string, error) { return "http://hub.example.test", "srv_1", nil },
		"user info":       func(context.Context) (string, string, error) { return "https://u:p@hub.example.test", "srv_1", nil },
		"javascript":      func(context.Context) (string, string, error) { return "javascript:alert(1)", "srv_1", nil },
		"bad server id":   func(context.Context) (string, string, error) { return "https://hub.example.test", "srv/../1", nil },
		"empty server id": func(context.Context) (string, string, error) { return "https://hub.example.test", "", nil },
		"no host":         func(context.Context) (string, string, error) { return "https:///x", "srv_1", nil },
	} {
		e.d.Enrolment = enrol
		assert.Equal(t, map[string]any{"offered": false}, e.d.ShareView(t.Context(), d, data), name)
	}
	e.d.Enrolment = func(context.Context) (string, string, error) { return "http://127.0.0.1:8421", "srv_1", nil }
	assert.Equal(t, true, e.d.ShareView(t.Context(), d, data)["offered"], "a loopback development Hub may be http")
	e.d.Enrolment = nil
	assert.Equal(t, map[string]any{"offered": false}, e.d.ShareView(t.Context(), d, data), "no enrolment source: not offered")
}

// coral-hub's ask 2 on #211336: a production (non-loopback) enrolment never builds an http share address, whatever the host looks like. Only a literal loopback host may be http (a development Hub).
func TestHubSharePage_ANonLoopbackEnrolmentNeverBuildsAnHTTPAddress(t *testing.T) {
	digest := strings.Repeat("c", 64)
	for _, hub := range []string{
		"http://hub.example.test", "http://hub.example.test:80", "http://hub.example.test:8421", "http://app.coralhub.dev",
		"http://localhost.evil.test", "http://127.0.0.1.evil.test", "http://127.0.0.1@hub.example.test", "http://evil.test#@127.0.0.1",
		"http://10.0.0.5", "http://[::2]", "http://0.0.0.0", "http://127.0.0.1.nip.io", "HTTP://hub.example.test", "ftp://hub.example.test", "//hub.example.test", "hub.example.test",
	} {
		assert.Empty(t, hubSharePage(hub, "srv_1", digest), hub)
	}
	assert.Equal(t, "https://app.coralhub.dev/dropbox/share/srv_1/"+digest, hubSharePage("https://app.coralhub.dev", "srv_1", digest))
	assert.Equal(t, "http://127.0.0.1:8421/dropbox/share/srv_1/"+digest, hubSharePage("http://127.0.0.1:8421", "srv_1", digest), "a literal loopback development Hub")
}

// #16206 (Security on #16109, SHOULD 1): the yes/no hint holds only digests of real artifacts, and at most hubDropboxSharedMax of them.
func TestHubDropboxShared_KeepsOnlyRealArtifactsAndIsCapped(t *testing.T) {
	e := newHDEnv(t)
	// a digest with no file here, and one whose name is a link or a folder, are not artifacts
	ghost := strings.Repeat("c", 64)
	_, got := e.call(e.d.SharedHint, `{"digest":"`+ghost+`","shared":true}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "no such artifact")
	assert.False(t, e.d.Shared(ghost))
	folder := strings.Repeat("d", 64)
	require.NoError(t, os.Mkdir(filepath.Join(e.dir, "artifacts", "objects", folder), 0o700))
	_, got = e.call(e.d.SharedHint, `{"digest":"`+folder+`","shared":true}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "a folder is not an artifact")
	linked := strings.Repeat("e", 64)
	require.NoError(t, os.Symlink(filepath.Join(e.dir, "artifacts", "objects", folder), filepath.Join(e.dir, "artifacts", "objects", linked)))
	_, got = e.call(e.d.SharedHint, `{"digest":"`+linked+`","shared":true}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "a link is not an artifact")
	assert.False(t, e.d.Shared(linked))

	// the cap: real artifacts up to the limit are kept, the next is not, a no frees a place, and a yes already held stays a yes
	digests := make([]string, 0, hubDropboxSharedMax+1)
	for i := 0; i <= hubDropboxSharedMax; i++ {
		d := fmt.Sprintf("%064x", i+1)
		require.NoError(t, os.WriteFile(filepath.Join(e.dir, "artifacts", "objects", d), []byte("x"), 0o600))
		digests = append(digests, d)
	}
	for _, d := range digests[:hubDropboxSharedMax] {
		_, got = e.call(e.d.SharedHint, `{"digest":"`+d+`","shared":true}`)
		require.JSONEq(t, `{"word":"ok"}`, got, d)
	}
	over := digests[hubDropboxSharedMax]
	_, got = e.call(e.d.SharedHint, `{"digest":"`+over+`","shared":true}`)
	assert.JSONEq(t, `{"word":"not_available"}`, got, "the hint is full")
	assert.False(t, e.d.Shared(over))
	_, got = e.call(e.d.SharedHint, `{"digest":"`+digests[0]+`","shared":true}`)
	assert.JSONEq(t, `{"word":"ok"}`, got, "a digest already held is still a yes at the cap")
	_, _ = e.call(e.d.SharedHint, `{"digest":"`+digests[1]+`","shared":false}`)
	assert.False(t, e.d.Shared(digests[1]))
	_, got = e.call(e.d.SharedHint, `{"digest":"`+over+`","shared":true}`)
	assert.JSONEq(t, `{"word":"ok"}`, got, "a no made room")
	assert.True(t, e.d.Shared(over))
}

// #16206 (Security on #16109, INFO 2): the link's path is checked decoded, so an encoded dot segment is refused like a plain one.
func TestHubDropboxValidPushLink_RefusesEncodedAndOtherDotSegments(t *testing.T) {
	ok := "https://content.dropboxapi.com/2/files/upload/TOKEN"
	assert.True(t, validPushLink(ok))
	for _, tail := range []string{
		"/2/files/%2e%2e/%2e%2e/oauth2/token", "/2/files/%2E%2E/x", "/2/files/a/%2e%2e/b", "/2/files/%2e/x", "/2/files/a/../b", "/2/files/./x",
		"/2/files//x", "/2/files/upload/", "/2/files/a%2f..%2fb", "/2/files/a/%2e%2e",
	} {
		assert.False(t, validPushLink("https://content.dropboxapi.com"+tail), tail)
	}
}

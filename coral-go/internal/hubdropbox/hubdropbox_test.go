package hubdropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dropbox"
)

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*31 + i>>8)
	}
	return b
}

// An independent, naive content_hash: block by block on a whole slice.
func naiveContentHash(b []byte) string {
	var cat []byte
	for i := 0; i < len(b); i += blockSize {
		e := i + blockSize
		if e > len(b) {
			e = len(b)
		}
		h := sha256.Sum256(b[i:e])
		cat = append(cat, h[:]...)
	}
	return sum(cat)
}

func TestReadOnce_HashesAtBlockEdges(t *testing.T) {
	for _, n := range []int{0, 1, blockSize - 1, blockSize, blockSize + 1, 2 * blockSize, MaxFile} {
		data := pattern(n)
		f, err := ReadOnce(bytes.NewReader(data))
		require.NoError(t, err, n)
		assert.Equal(t, int64(n), f.Size, n)
		assert.Equal(t, sum(data), f.Digest, n)
		assert.Equal(t, naiveContentHash(data), f.ContentHash, "size %d", n)
		assert.Equal(t, dropbox.ContentHash(data), f.ContentHash, "the existing client's hash, size %d", n)
	}
}

func TestReadOnce_EmptyFileHashIsDropboxsKnownValue(t *testing.T) {
	f, err := ReadOnce(strings.NewReader(""))
	require.NoError(t, err)
	// SHA-256 of nothing (no blocks): Dropbox's content_hash of an empty file.
	assert.Equal(t, sum(nil), f.ContentHash)
	assert.Equal(t, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", f.ContentHash)
}

func TestReadOnce_OverTheCapIsRefusedNotCut(t *testing.T) {
	_, err := ReadOnce(bytes.NewReader(pattern(MaxFile + 1)))
	assert.ErrorIs(t, err, ErrTooBig)
}

type oneShot struct {
	r     io.Reader
	reads int
}

func (o *oneShot) Read(p []byte) (int, error) { o.reads++; return o.r.Read(p) }

func TestReadOnce_ReadsTheSourceOnlyToItsEnd(t *testing.T) {
	src := &oneShot{r: bytes.NewReader(pattern(300 << 10))}
	f, err := ReadOnce(src)
	require.NoError(t, err)
	assert.Equal(t, sum(f.Data), f.Digest, "digest, hash and bytes come from the same read")
	assert.LessOrEqual(t, src.reads, 10)
}

// canaryPAT is built at run time so no token-shaped literal sits in the source (gitleaks).
var canaryPAT = "ghp_" + strings.Repeat("a", 36)

func TestFlagged_CanarySecretAndCleanText(t *testing.T) {
	f, err := ReadOnce(strings.NewReader("notes\nAuthorization: Bearer " + canaryPAT + "\n"))
	require.NoError(t, err)
	assert.True(t, f.Flagged, "a token in the file flags it")
	f, err = ReadOnce(strings.NewReader("just some meeting notes, no secrets"))
	require.NoError(t, err)
	assert.False(t, f.Flagged)
}

func TestFlagged_ABinaryFileIsScannedAsBytes(t *testing.T) {
	b := append([]byte{0xff, 0xfe, 0x00}, []byte("Authorization: Bearer "+canaryPAT)...)
	f, err := ReadOnce(bytes.NewReader(b))
	require.NoError(t, err)
	assert.True(t, f.Flagged)
}

const goodLink = "https://content.dropboxapi.com/apitul/1/CANARYTOKEN123"

func TestValidLink(t *testing.T) {
	_, err := ValidLink(goodLink)
	assert.NoError(t, err)
	_, err = ValidLink("https://content.dropboxapi.com:443/apitul/1/x")
	assert.NoError(t, err)
	for _, bad := range []string{
		"http://content.dropboxapi.com/x",
		"https://content.dropboxapi.com.evil.example/x",
		"https://evil.example/content.dropboxapi.com",
		"https://user:pw@content.dropboxapi.com/x",
		"https://content.dropboxapi.com:8443/x",
		"https://content.dropboxapi.com@evil.example/x",
		"https://api.dropboxapi.com/x",
		"https://CONTENT.dropboxapi.com.evil.example/x",
		"javascript:alert(1)", "data:text/plain,hi", "//content.dropboxapi.com/x", "", "https://content.dropboxapi.com/x#frag",
	} {
		_, err := ValidLink(bad)
		assert.ErrorIs(t, err, ErrBadLink, bad)
	}
}

type rt func(*http.Request) (*http.Response, error)

func (f rt) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func reply(code int, h map[string]string) *http.Response {
	r := &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("body that must not be echoed"))}
	for k, v := range h {
		r.Header.Set(k, v)
	}
	return r
}

func allow(context.Context) (bool, error) { return true, nil }

func fileOf(t *testing.T, s string) *File {
	f, err := ReadOnce(strings.NewReader(s))
	require.NoError(t, err)
	return f
}

func TestUpload_SendsExactlyTheBytesOnce(t *testing.T) {
	f := fileOf(t, "hello dropbox")
	var seen int
	var got []byte
	var clen int64
	u := newUploader(rt(func(r *http.Request) (*http.Response, error) {
		seen++
		clen = r.ContentLength
		got, _ = io.ReadAll(r.Body)
		return reply(200, nil), nil
	}), allow)
	require.NoError(t, u.Upload(context.Background(), goodLink, f.Digest, f))
	assert.Equal(t, 1, seen)
	assert.Equal(t, f.Data, got)
	assert.Equal(t, int64(len(f.Data)), clen)
}

func TestUpload_DigestMustMatchBeforeAnyByteIsSent(t *testing.T) {
	f := fileOf(t, "approved text")
	asked := sum([]byte("approved text"))
	f.Data = []byte("edited after the confirm") // the bytes changed after the scan
	sent := false
	u := newUploader(rt(func(*http.Request) (*http.Response, error) { sent = true; return reply(200, nil), nil }), allow)
	err := u.Upload(context.Background(), goodLink, asked, f)
	assert.ErrorIs(t, err, ErrDigestMismatch)
	assert.False(t, sent)
	// and a request for a different digest than the read one
	g := fileOf(t, "other")
	assert.ErrorIs(t, u.Upload(context.Background(), goodLink, sum([]byte("not other")), g), ErrDigestMismatch)
	assert.False(t, sent)
}

func TestUpload_BadLinkSendsNothing(t *testing.T) {
	f := fileOf(t, "x")
	sent := false
	u := newUploader(rt(func(*http.Request) (*http.Response, error) { sent = true; return reply(200, nil), nil }), allow)
	for _, l := range []string{"http://content.dropboxapi.com/x", "https://evil.example/x", "https://content.dropboxapi.com:99/x", "https://u:p@content.dropboxapi.com/x"} {
		assert.ErrorIs(t, u.Upload(context.Background(), l, f.Digest, f), ErrBadLink, l)
	}
	assert.False(t, sent)
}

func TestUpload_TheGateIsAskedRightBeforeTheBytesAndFailsClosed(t *testing.T) {
	f := fileOf(t, "x")
	for name, gate := range map[string]func(context.Context) (bool, error){
		"private or internal": func(context.Context) (bool, error) { return false, nil },
		"unreadable mark":     func(context.Context) (bool, error) { return true, errors.New("db locked") },
		"no gate":             nil,
	} {
		sent := false
		u := newUploader(rt(func(*http.Request) (*http.Response, error) { sent = true; return reply(200, nil), nil }), gate)
		assert.ErrorIs(t, u.Upload(context.Background(), goodLink, f.Digest, f), ErrNotAllowed, name)
		assert.False(t, sent, name)
	}
	order := []string{}
	u := newUploader(rt(func(*http.Request) (*http.Response, error) {
		order = append(order, "send")
		return reply(200, nil), nil
	}),
		func(context.Context) (bool, error) { order = append(order, "gate"); return true, nil })
	require.NoError(t, u.Upload(context.Background(), goodLink, f.Digest, f))
	assert.Equal(t, []string{"gate", "send"}, order)
}

func TestUpload_NeverFollowsARedirect(t *testing.T) {
	f := fileOf(t, "x")
	hits := 0
	u := newUploader(rt(func(r *http.Request) (*http.Response, error) {
		hits++
		return reply(302, map[string]string{"Location": "https://evil.example/steal"}), nil
	}), allow)
	err := u.Upload(context.Background(), goodLink, f.Digest, f)
	var ref *Refused
	require.ErrorAs(t, err, &ref)
	assert.Equal(t, 302, ref.Status)
	assert.Equal(t, 1, hits, "the redirect target is never requested")
}

func TestUpload_ProductionTransportTakesNoProxyFromTheEnvironment(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")
	u := NewUploader(allow)
	tr, ok := u.client.Transport.(*http.Transport)
	require.True(t, ok)
	require.Nil(t, tr.Proxy)
	assert.NotNil(t, u.client.CheckRedirect)
}

func TestUpload_ErrorsNeverCarryTheLinkOrTheReplyBody(t *testing.T) {
	f := fileOf(t, "x")
	u := newUploader(rt(func(*http.Request) (*http.Response, error) {
		return nil, &urlErr{link: goodLink}
	}), allow)
	err := u.Upload(context.Background(), goodLink, f.Digest, f)
	assert.ErrorIs(t, err, ErrNetwork)
	assert.NotContains(t, err.Error(), "CANARYTOKEN123")
	u = newUploader(rt(func(*http.Request) (*http.Response, error) { return reply(409, nil), nil }), allow)
	err = u.Upload(context.Background(), goodLink, f.Digest, f)
	assert.NotContains(t, err.Error(), "body that must not")
	assert.NotContains(t, err.Error(), "CANARYTOKEN123")
}

type urlErr struct{ link string }

func (e *urlErr) Error() string { return "Post " + e.link + ": connection refused" }

func TestUpload_RetryAfterIsClamped(t *testing.T) {
	f := fileOf(t, "x")
	for hdr, want := range map[string]time.Duration{"": time.Minute, "abc": time.Minute, "0": time.Minute, "-5": time.Minute, "30": 30 * time.Second, "999999": time.Hour, "99999999999999999999": time.Minute, "9223372036": time.Hour} {
		u := newUploader(rt(func(*http.Request) (*http.Response, error) {
			return reply(429, map[string]string{"Retry-After": hdr}), nil
		}), allow)
		var rl *RateLimited
		require.ErrorAs(t, u.Upload(context.Background(), goodLink, f.Digest, f), &rl, hdr)
		assert.Equal(t, want, rl.After, "Retry-After %q", hdr)
	}
}

func TestFlagged_AScanThatFailsIsNotClean(t *testing.T) {
	old := Scan
	defer func() { Scan = old }()
	Scan = func([]byte) ([]byte, error) { panic("scanner broke") }
	f, err := ReadOnce(strings.NewReader("harmless text"))
	require.NoError(t, err)
	assert.True(t, f.Flagged, "a scan that panicked is held, never clean")
	Scan = func(b []byte) ([]byte, error) { return b, errors.New("scanner failed") }
	f, err = ReadOnce(strings.NewReader("harmless text"))
	require.NoError(t, err)
	assert.True(t, f.Flagged, "a scan that returned an error is held, never clean")
}

func TestUpload_MapsDropboxsAnswers(t *testing.T) {
	f := fileOf(t, "x")
	body := func(code int, text string) *http.Response {
		r := reply(code, nil)
		r.Body = io.NopCloser(strings.NewReader(text))
		return r
	}
	for name, c := range map[string]struct {
		resp *http.Response
		full bool
		code int
	}{
		"space full": {body(409, `{"error_summary":"insufficient_space/..."}`), true, 409},
		"other 409":  {body(409, `{"error_summary":"path/conflict"}`), false, 409},
		"expired":    {body(410, ""), false, 410},
		"server":     {body(500, ""), false, 500},
	} {
		u := newUploader(rt(func(*http.Request) (*http.Response, error) { return c.resp, nil }), allow)
		var ref *Refused
		require.ErrorAs(t, u.Upload(context.Background(), goodLink, f.Digest, f), &ref, name)
		assert.Equal(t, c.code, ref.Status, name)
		assert.Equal(t, c.full, ref.QuotaFull, name)
	}
}

package hubproxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
)

// pacedUpload exercises real request-body reads and the production 30 s bound.
// Close interrupts a pending read when the proxy rejects an upload early.
type pacedUpload struct {
	ctx       context.Context
	cancel    context.CancelFunc
	remaining int64
	interval  time.Duration
}

func (b *pacedUpload) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		return 0, io.EOF
	}
	timer := time.NewTimer(b.interval)
	defer timer.Stop()
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-timer.C:
	}
	n := min(len(p), 32*1024, int(b.remaining))
	clear(p[:n])
	b.remaining -= int64(n)
	return n, nil
}
func (b *pacedUpload) Close() error { b.cancel(); return nil }

// Both of the next two tests run the production handler with the production 30 s bounds under fake time (testing/synctest), against a Target
// that reads the upload and answers in the test: no sockets, since a bubble does not advance its clock while a goroutine waits on the network.
// They used to take 45 s and 31 s of real time against a loopback server.

// A 45 s upload that never stalls for 30 s is not cut by the 30 s wait for the machine's reply: that wait starts when the upload has been consumed.
func TestProxyHeaderTimeoutSlowUpload(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const size = 5 * 1024 * 1024
		body := &pacedUpload{remaining: size, interval: 45 * time.Second / (size / (32 * 1024)), cancel: func() {}}
		var received int64
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			body.ctx = r.Context()
			var err error
			if received, err = io.Copy(io.Discard, r.Body); err != nil {
				return nil, err
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}},
				Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = size
		recorder := httptest.NewRecorder()
		started := time.Now()
		(&Handler{}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Equal(t, int64(size), received)
		require.GreaterOrEqual(t, time.Since(started), 45*time.Second)
		require.JSONEq(t, `{"ok":true}`, recorder.Body.String())
	})
}

// stalledUpload sends a few bytes at once and then, after 31 s, a few more: a browser upload that stops for longer than the 30 s stall limit.
type stalledUpload struct {
	ctx  context.Context
	sent bool
}

func (b *stalledUpload) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, "upload started"), nil
	}
	pause := time.NewTimer(31 * time.Second)
	defer pause.Stop()
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-pause.C:
		return copy(p, "too late"), nil
	}
}

// An upload that stops for 30 s is cut with the stall code, not reported as an outage of the machine, and the target's reader is released.
func TestProxyUploadStallTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		res := &fakeResolver{targets: map[string]HTTPTarget{}, errs: map[string]error{}}
		body := &stalledUpload{}
		remoteDone := make(chan struct{})
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			defer close(remoteDone)
			body.ctx = r.Context()
			_, err := io.Copy(io.Discard, r.Body)
			return nil, err
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		started := time.Now()
		(&Handler{resolver: res}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		requireUploadCut(t, recorder.Code, recorder.Body, CodeUploadStalled)
		require.False(t, res.hasMark("a:"+StatusUnreachable), "a slow browser upload is not an outage of the machine")
		require.Equal(t, 30*time.Second, time.Since(started), "the stall limit counts from the last byte of the upload")
		select {
		case <-remoteDone:
		default:
			t.Fatal("stalled upstream body reader was not released")
		}
	})
}

// The 30 s wait for the machine's reply starts when the browser's body has ended, not when the request started; a machine that never sends headers is answered 502 and its
// request is cancelled. For a chunked upload, a request with no body and an event-stream request. Fake time (testing/synctest) with a Target that reads the body and then waits.
func TestProxyHeaderTimeoutAfterBody(t *testing.T) {
	for _, tc := range []struct {
		name string
		body bool
		sse  bool
	}{
		{name: "chunked upload", body: true},
		{name: "no body"},
		{name: "event stream", sse: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var bodyEnded time.Time
				upstreamCancelled := false
				var body *pacedUpload
				var reqBody io.Reader
				if tc.body {
					body = &pacedUpload{remaining: 4 * 32 * 1024, interval: 500 * time.Millisecond, cancel: func() {}}
					reqBody = body
				}
				target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
					if body != nil {
						body.ctx = r.Context()
					}
					if r.Body != nil && r.Body != http.NoBody { // a request with no body reaches the transport with none
						if _, err := io.Copy(io.Discard, r.Body); err != nil {
							return nil, err
						}
					}
					bodyEnded = time.Now()
					<-r.Context().Done() // The machine never sends response headers.
					upstreamCancelled = true
					return nil, r.Context().Err()
				}}
				req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", reqBody)
				if tc.body {
					req.ContentLength = -1
				}
				if tc.sse {
					req.Header.Set("Accept", "text/event-stream")
				}
				recorder := httptest.NewRecorder()
				(&Handler{}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
				answered := time.Now()
				require.Equal(t, http.StatusBadGateway, recorder.Code, recorder.Body.String())
				elapsed := answered.Sub(bodyEnded)
				require.GreaterOrEqual(t, elapsed, 29*time.Second, "30 s starts after the body, not at request start")
				require.Less(t, elapsed, 35*time.Second)
				require.True(t, upstreamCancelled, "upstream context was not canceled")
			})
		})
	}
}

// The one stall test that keeps real sockets and the real 30 s (#6190): a browser upload through the hub to a loopback machine that stops for 31 s. The bubble tests above
// check the handler's logic; this one checks that the bound reaches the actual connection and body read (a deadline on the wrong object, a client without a timeout).
// It is t.Parallel(), so its 30 s overlaps the rest of the package.
func TestProxyUploadStallTimeoutRealSocket(t *testing.T) {
	t.Parallel()
	remoteDone := make(chan struct{})
	res, hub, _ := setup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(remoteDone)
		_, _ = io.Copy(io.Discard, r.Body)
	}), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	go func() {
		_, _ = writer.Write([]byte("upload started"))
		pause := time.NewTimer(31 * time.Second)
		defer pause.Stop()
		select {
		case <-ctx.Done():
		case <-pause.C:
			_, _ = writer.Write([]byte("too late"))
		}
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hub.URL+"/api/remote/a/api/upload", reader)
	require.NoError(t, err)
	started := time.Now()
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	requireUploadCut(t, resp.StatusCode, resp.Body, CodeUploadStalled)
	require.False(t, res.hasMark("a:"+StatusUnreachable), "a slow browser upload is not an outage of the machine")
	require.GreaterOrEqual(t, time.Since(started), 29*time.Second)
	require.Less(t, time.Since(started), 35*time.Second)
	select {
	case <-remoteDone:
	case <-time.After(2 * time.Second):
		t.Fatal("stalled upstream body reader was not released")
	}
}

type uploadTimeoutTarget struct {
	HTTPTarget
	roundTrip func(*http.Request) (*http.Response, error)
}

func (t uploadTimeoutTarget) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.roundTrip(r)
}

// Fake time exercises the actual ten-minute production cap without adding a
// ten-minute CI delay. The target reads continuously until context cancellation.
func TestProxyUploadOverallTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		body := &pacedUpload{remaining: 1 << 60, interval: time.Second, cancel: func() {}}
		var received int64
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			body.ctx = r.Context()
			var err error
			received, err = io.Copy(io.Discard, r.Body)
			return nil, err
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		started := time.Now()
		(&Handler{}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		requireUploadCut(t, recorder.Code, recorder.Body, CodeUploadTooSlow)
		require.Equal(t, 10*time.Minute, time.Since(started), "moving bytes reset the idle limit, never the total cap")
		require.Greater(t, received, int64(0))
		require.Greater(t, body.remaining, int64(0), "the trickle never reached EOF")
	})
}

// Receiving response headers must not remove the limits on an ongoing upload.
func TestProxyUploadTimeoutAfterEarlyResponse(t *testing.T) {
	for _, tc := range []struct {
		name     string
		interval time.Duration
		cutoff   time.Duration
	}{
		{name: "silent body", interval: time.Hour, cutoff: 30 * time.Second},
		{name: "endless trickle", interval: time.Second, cutoff: 10 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				body := &pacedUpload{remaining: 1 << 60, interval: tc.interval, cancel: func() {}}
				received := make(chan int64, 1)
				started := time.Now()
				target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
					body.ctx = r.Context()
					reader, writer := io.Pipe()
					go func() {
						n, _ := io.Copy(io.Discard, r.Body)
						received <- n
						_ = writer.Close()
					}()
					// Reply at once, but keep the response and upload open until
					// the proxy cancels the request rather than returning EOF.
					require.Zero(t, time.Since(started))
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: reader}, nil
				}}
				req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
				req.ContentLength = -1
				recorder := httptest.NewRecorder()
				(&Handler{}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
				require.Equal(t, http.StatusOK, recorder.Code, "the early response was forwarded")
				require.Equal(t, tc.cutoff, time.Since(started))
				if tc.name == "silent body" {
					require.Zero(t, <-received)
				} else {
					require.Greater(t, <-received, int64(0))
				}
				require.Greater(t, body.remaining, int64(0), "the body did not reach EOF")
			})
		})
	}
}

func TestProxyUploadProgressResetsStall(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		body := &pacedUpload{remaining: 1 << 60, interval: 20 * time.Second, cancel: func() {}}
		started := time.Now()
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			body.ctx = r.Context()
			// The browser sends one byte at 20 s, then goes silent. The
			// callback at 30 s must rearm for the remaining 20 s of idle time.
			n, err := r.Body.Read(make([]byte, 1))
			require.NoError(t, err)
			require.Equal(t, 1, n)
			require.Equal(t, 20*time.Second, time.Since(started))
			body.interval = time.Hour
			_, err = io.Copy(io.Discard, r.Body)
			return nil, err
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		(&Handler{}).proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		requireUploadCut(t, recorder.Code, recorder.Body, CodeUploadStalled)
		require.Equal(t, 50*time.Second, time.Since(started), "stall time starts at the most recent body byte")
	})
}

// requireUploadCut pins the reply to an upload the proxy ended (#6190): 408 with a fixed code naming the limit,
// never the generic "remote unreachable" that means the machine is down.
func requireUploadCut(t *testing.T, status int, body io.Reader, code string) {
	t.Helper()
	require.Equal(t, http.StatusRequestTimeout, status)
	var reply map[string]string
	require.NoError(t, json.NewDecoder(body).Decode(&reply))
	require.Equal(t, code, reply["code"])
	require.NotContains(t, reply["error"], "unreachable")
}

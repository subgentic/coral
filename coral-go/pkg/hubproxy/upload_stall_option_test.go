package hubproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
)

// A caller may shorten the upload stall bound through Options (fake time, so the test
// does not wait). Production never sets it.
func TestUploadStallTimeoutOptionShortensTheBound(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		body := &pacedUpload{remaining: 1 << 60, interval: time.Millisecond, cancel: func() {}}
		started := time.Now()
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			body.ctx = r.Context()
			_, err := r.Body.Read(make([]byte, 4))
			require.NoError(t, err)
			body.interval = time.Hour // the browser stops after a few bytes
			_, err = io.Copy(io.Discard, r.Body)
			return nil, err
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		h := &Handler{opts: Options{UploadStallTimeout: 200 * time.Millisecond}}
		h.proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		requireUploadCut(t, recorder.Code, recorder.Body, CodeUploadStalled)
		require.Equal(t, 201*time.Millisecond, time.Since(started), "the bound runs from the last body byte")
	})
}

// Progress inside the bound is not a stall, however short the bound is.
func TestUploadStallTimeoutOptionKeepsAnUploadThatProgresses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		body := &pacedUpload{remaining: 10 * 32 * 1024, interval: 100 * time.Millisecond, cancel: func() {}}
		target := uploadTimeoutTarget{roundTrip: func(r *http.Request) (*http.Response, error) {
			body.ctx = r.Context()
			_, err := io.Copy(io.Discard, r.Body)
			if err != nil {
				return nil, err
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/remote/a/api/upload", body)
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		h := &Handler{opts: Options{UploadStallTimeout: 300 * time.Millisecond}}
		h.proxyHTTP(recorder, req, "a", target, "/api/upload", "/api/upload")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	})
}

// The option can only shorten the bound: zero and negative are the default, and the value
// is held between 100 ms and the default. Read the value, never wait for it.
func TestUploadStallTimeoutIsClamped(t *testing.T) {
	require.Equal(t, 30*time.Second, defaultUploadStallTimeout)
	for name, tc := range map[string]struct{ set, want time.Duration }{
		"zero is the default":     {0, defaultUploadStallTimeout},
		"negative is the default": {-1, defaultUploadStallTimeout},
		"over the default is cut": {60 * time.Second, defaultUploadStallTimeout},
		"just over is cut":        {defaultUploadStallTimeout + 1, defaultUploadStallTimeout},
		"the default stays":       {defaultUploadStallTimeout, defaultUploadStallTimeout},
		"under 100 ms is raised":  {1, 100 * time.Millisecond},
		"100 ms stays":            {100 * time.Millisecond, 100 * time.Millisecond},
		"in between stays as set": {2 * time.Second, 2 * time.Second},
	} {
		require.Equal(t, tc.want, Options{UploadStallTimeout: tc.set}.stallTimeout(), name)
	}
	require.Equal(t, defaultUploadStallTimeout, (&Handler{}).opts.stallTimeout())
}

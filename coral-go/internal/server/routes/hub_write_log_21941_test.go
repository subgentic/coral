package routes

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
)

// #21941: every write a Hub relays leaves one line naming the link and the Hub account id; a refused one only its status code; a read, and a request that did not come through the Hub, leave none.

func hubWriteLogRun(t *testing.T, on, tunneled bool, method, target string, status int) string {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(old)
	g := RelayedGuard(func() *devicekey.Verifier { return &devicekey.Verifier{Store: emptyStore{}} }, func(context.Context) (string, error) { return rlOwner, nil }, func(context.Context) bool { return on })
	r := httptest.NewRequest(method, target, strings.NewReader("{}"))
	stamp(r)
	if tunneled {
		r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: rlOwner}))
	}
	g(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })).ServeHTTP(httptest.NewRecorder(), r)
	return buf.String()
}

func TestAHubRelayedWriteIsLoggedWithTheLinkAndTheAccountAndARefusalWithOnlyItsCode(t *testing.T) {
	const send = "/api/sessions/live/agent1/send"
	acc := hubWriteLogRun(t, false, true, "POST", send, http.StatusOK)
	assert.Contains(t, acc, "a relayed write was accepted")
	assert.Contains(t, acc, "link="+rlLink)
	assert.Contains(t, acc, "account="+rlOwner)
	assert.NotContains(t, acc, "agent1", "no route or name is logged")

	ref := hubWriteLogRun(t, false, true, "POST", send, http.StatusForbidden)
	assert.Contains(t, ref, "a relayed write was refused")
	assert.Contains(t, ref, "status=403")
	assert.NotContains(t, ref, rlOwner, "a refusal names no account")
	assert.NotContains(t, ref, rlLink)

	// the switch's own refusal (device_required, 403) is a refusal line too, and the handler is never reached
	on := hubWriteLogRun(t, true, true, "POST", send, http.StatusOK)
	assert.Contains(t, on, "a relayed write was refused")
	assert.Contains(t, on, "status=403")
	assert.NotContains(t, on, rlOwner)

	assert.NotContains(t, hubWriteLogRun(t, false, true, "GET", "/api/sessions/live", http.StatusOK), "relayed write", "a read is not a write")
	assert.NotContains(t, hubWriteLogRun(t, false, false, "POST", send, http.StatusOK), "relayed write", "a request that did not come through the Hub is not logged here")
}

func TestARelayedStreamingWriteStillFlushesBehindTheAttributionLog(t *testing.T) {
	g := RelayedGuard(func() *devicekey.Verifier { return &devicekey.Verifier{Store: emptyStore{}} }, func(context.Context) (string, error) { return rlOwner, nil }, func(context.Context) bool { return false })
	r := httptest.NewRequest("POST", "/api/sessions/live/agent1/send", strings.NewReader("{}"))
	stamp(r)
	r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: rlOwner}))
	rec := httptest.NewRecorder()
	var canFlush bool
	g(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, ok := w.(http.Flusher)
		canFlush = ok
		_, _ = w.Write([]byte("a"))
		if ok {
			f.Flush()
		}
	})).ServeHTTP(rec, r)
	assert.True(t, canFlush, "the handler still sees a Flusher")
	assert.True(t, rec.Flushed, "and its flush reaches the writer underneath")
}

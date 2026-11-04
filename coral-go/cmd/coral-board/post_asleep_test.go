package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13189: a post to an agent that will not read it now says so in the CLI's answer, one line per recipient, as the server words it; a post to awake agents, and an older server, say nothing more.
func TestAPostToAnAgentThatIsAsleepSaysSoToTheSender(t *testing.T) {
	serve := func(extra string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/api/health" {
				w.Write([]byte(`{"status":"ok","version":"test"}`))
				return
			}
			w.Write([]byte(`{"id":5,"notified":["Dev A","QA"]` + extra + `}`))
		}))
	}
	srv := serve(`,"asleep":[{"name":"Dev A","state":"asleep","note":"Dev A is asleep; the message waits until it wakes."},{"name":"QA","state":"terminal_gone","note":"QA's terminal is gone; the message waits until it is restarted."}]`)
	res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), "post", "@Dev A @QA ready")
	srv.Close()
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Message #5 posted")
	assert.Contains(t, res.stdout, "  Note: Dev A is asleep; the message waits until it wakes.\n")
	assert.Contains(t, res.stdout, "  Note: QA's terminal is gone; the message waits until it is restarted.\n")

	for name, extra := range map[string]string{"awake recipients": ``, "an empty list": `,"asleep":[]`} {
		srv := serve(extra)
		res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), "post", "@Dev A ready")
		srv.Close()
		require.Equal(t, 0, res.code, "%s: %q", name, res.stderr)
		assert.NotContains(t, res.stdout, "Note:", name)
	}
}

package tunnel

import (
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20581 (b): a long stream of a named Hub person is recorded while it is open, EndOpenStreams ends it, and it is gone from the record afterwards; a stream of no named person is never recorded.
func TestAnOpenEventStreamOfAHubPersonIsRecordedAndEndedOnDemand(t *testing.T) {
	var handlerDone atomic.Bool
	rig := &limitRig{t: t, release: make(chan struct{})}
	t.Cleanup(rig.free)
	rig.sess, _ = connect(t, newHub(t, fastCfg()), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/board/team1/messages" {
			w.Write([]byte("ok"))
			return
		}
		defer handlerDone.Store(true)
		w.Header().Set("Content-Type", "text/event-stream")
		for r.Context().Err() == nil {
			io.WriteString(w, "data: x\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(10 * time.Millisecond)
		}
	}), func(l *LocalHandler) { l.LinkID = "lnk-test0001" })

	keysOf := func(user string) (n int) {
		for _, k := range OpenStreamKeys() {
			if k.User == user {
				n++
			}
		}
		return
	}
	open := func(user string) *http.Response {
		req, _ := http.NewRequest("GET", "http://x/api/board/team1/messages", nil)
		req.Header.Set("Accept", "text/event-stream")
		req = req.WithContext(WithHubUser(req.Context(), user))
		resp, err := rig.sess.RoundTrip(req)
		require.NoError(t, err)
		_, err = io.ReadFull(resp.Body, make([]byte, 6))
		require.NoError(t, err)
		return resp
	}
	nobody := open("")
	defer nobody.Body.Close()
	assert.Zero(t, keysOf(""), "a stream with no named person is not recorded")

	resp := open("hub-user-aaaa1111")
	defer resp.Body.Close()
	require.Equal(t, 1, keysOf("hub-user-aaaa1111"))
	var key OpenStreamKey
	for _, k := range OpenStreamKeys() {
		if k.User == "hub-user-aaaa1111" {
			key = k
		}
	}
	assert.Equal(t, "lnk-test0001", key.Link)
	assert.Equal(t, TierView, key.Need, "the tier its route needs")

	assert.Equal(t, 1, EndOpenStreams(key))
	assert.Eventually(t, handlerDone.Load, 5*time.Second, 20*time.Millisecond, "the local handler ended")
	assert.Eventually(t, func() bool { return keysOf("hub-user-aaaa1111") == 0 }, 5*time.Second, 20*time.Millisecond, "and it left the record")
}

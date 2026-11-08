package tunnel

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14656 (coral-hub #192951): behind the Hub the 57th GET /api/proposals was refused 429 and every later one too, with no recovery. The machine's pools count requests IN FLIGHT and must give every slot back on every
// path (answered whole, body dropped unread, caller gone mid-request): a long run of sequential reads, as one user and as the hub's own stream, never meets a 429 and leaves the pools empty. 300 reads (five times past 57).
func TestSequentialHubReadsNeverFillThePoolsOnAnyPath(t *testing.T) {
	const path = "/api/proposals?state=pending,approving,expired"
	for name, ctxFor := range map[string]func() (context.Context, context.CancelFunc){
		"a Hub user": func() (context.Context, context.CancelFunc) {
			return WithHubUser(context.Background(), "hub-user-aaaaaaaa"), func() {}
		},
		"the hub's own": func() (context.Context, context.CancelFunc) { return context.Background(), func() {} },
		"a caller that gives up at once": func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(WithHubUser(context.Background(), "hub-user-bbbbbbbb"))
			return ctx, cancel
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newLimitRig(t, HubLimits{})
			refused := 0
			for i := 0; i < 300; i++ {
				ctx, cancel := ctxFor()
				req, _ := http.NewRequestWithContext(ctx, "GET", "http://x"+path, nil)
				resp, err := rig.sess.RoundTrip(req)
				if name == "a caller that gives up at once" {
					cancel() // gone before reading the body
					if err == nil {
						resp.Body.Close()
					}
					continue
				}
				require.NoError(t, err, "read %d", i+1)
				if resp.StatusCode == http.StatusTooManyRequests {
					refused++
				}
				if i%2 == 0 {
					_, _ = io.Copy(io.Discard, resp.Body)
				} // the others drop the body unread
				resp.Body.Close()
				cancel()
			}
			assert.Zero(t, refused, "no read of 300 was refused with a 429")
			require.Eventually(t, rig.idle, 5*time.Second, 10*time.Millisecond, "every slot is given back")
			resp, body := rig.get(path) // and the next read still works
			assert.Equal(t, http.StatusOK, resp.StatusCode, body)
		})
	}
}

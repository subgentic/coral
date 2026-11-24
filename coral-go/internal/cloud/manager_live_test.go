package cloud

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// Coral Live (#21074, Security's condition from #21071): a live request goes through the tunnel of the Hub link it names, and only that one. No tunnel for that id is a refusal, never another Hub link.
func TestALivePushGoesThroughTheNamedHubLinksTunnelOnly(t *testing.T) {
	e := newEnv(t)
	var mu sync.Mutex
	var seen []string
	rec := func(name string) func(tunnel.LiveRequest) []byte {
		return func(req tunnel.LiveRequest) []byte {
			mu.Lock()
			defer mu.Unlock()
			seen = append(seen, name+" "+req.Path)
			return []byte(`{"ok":true}`)
		}
	}
	e.hub.liveHook.Store(rec("hub1")) // set before the dial: the capability is chosen at the handshake
	m, hub2, a, b := twoLinks(t, e, "view")
	hub2.liveHook.Store(rec("hub2"))
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateConnected)

	ctx := context.Background()
	r, err := m.Live(ctx, a.LinkID, tunnel.LiveFramePath, []byte(`{}`))
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(r.Body))
	_, err = m.Live(ctx, b.LinkID, tunnel.LivePausedPath, []byte(`{}`))
	require.NoError(t, err)
	mu.Lock()
	assert.Equal(t, []string{"hub1 " + tunnel.LiveFramePath, "hub2 " + tunnel.LivePausedPath}, seen, "each went to its own Hub")
	mu.Unlock()

	_, err = m.Live(ctx, "lnk-unknown", tunnel.LiveFramePath, []byte(`{}`))
	assert.ErrorIs(t, err, ErrNotLinked, "an id with no tunnel is refused")
	m.StopLink(b.LinkID)
	_, err = m.Live(ctx, b.LinkID, tunnel.LiveFramePath, []byte(`{}`))
	assert.ErrorIs(t, err, ErrNotLinked, "a link whose tunnel is gone does not fall back to the other Hub")
	mu.Lock()
	assert.Len(t, seen, 2)
	mu.Unlock()
}

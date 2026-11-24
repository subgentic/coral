package tunnel

import (
	"context"
	"net/http"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Coral Live (#21064): the kind "live", capability live_push/1, one request per stream, three paths, nothing the hub opens toward the connector.

func liveHub(t *testing.T, caps []string, on LiveFunc) *hubHarness {
	t.Helper()
	cfg := SessionConfig{OnLive: on}
	if caps != nil {
		cfg.Capabilities = func(any) []string { return caps }
	}
	return newHub(t, cfg)
}

func TestALiveRequestReachesTheHubHookOnItsPathAndTheReplyComesBack(t *testing.T) {
	var mu sync.Mutex
	var got []LiveRequest
	h := liveHub(t, []string{CapabilityLive}, func(_ context.Context, s *Session, req LiveRequest) RelayResponse {
		mu.Lock()
		got = append(got, req)
		mu.Unlock()
		assert.Equal(t, "server-1", s.Identity(), "the source is the tunnel, never the request")
		return RelayResponse{Status: http.StatusOK, Body: []byte(`{"ok":true}`)}
	})
	_, cs := connect(t, h, noopLocal(), nil)
	require.True(t, cs.CanLive())
	for _, p := range []string{LiveFramePath, LiveConfirmPath, LivePausedPath} {
		r, err := cs.Live(context.Background(), p, []byte(`{"link":"x"}`))
		require.NoError(t, err)
		assert.Equal(t, http.StatusOK, r.Status)
		assert.JSONEq(t, `{"ok":true}`, string(r.Body))
	}
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, got, 3)
	assert.Equal(t, LivePausedPath, got[2].Path)
}

func TestLiveIsOnlyOpenedWhenTheHubSaidYes(t *testing.T) {
	ok := func(context.Context, *Session, LiveRequest) RelayResponse { return RelayResponse{Status: 200} }
	for name, h := range map[string]*hubHarness{
		"no capabilities hook": liveHub(t, nil, ok),
		"hook says no":         liveHub(t, []string{}, ok),
		"no OnLive handler":    liveHub(t, []string{CapabilityLive}, nil),
		"only relay":           liveHub(t, []string{CapabilityRelay}, ok),
	} {
		_, cs := connect(t, h, noopLocal(), nil)
		assert.False(t, cs.CanLive(), name)
		_, err := cs.Live(context.Background(), LiveFramePath, []byte(`{}`))
		assert.ErrorIs(t, err, ErrLiveUnsupported, name)
	}
}

func TestLiveRefusesAnotherPathAndABodyOverItsCapBeforeSending(t *testing.T) {
	calls := 0
	h := liveHub(t, []string{CapabilityLive}, func(context.Context, *Session, LiveRequest) RelayResponse {
		calls++
		return RelayResponse{Status: 200, Body: []byte(`{"ok":true}`)}
	})
	_, cs := connect(t, h, noopLocal(), nil)
	_, err := cs.Live(context.Background(), "/live/v1/other", []byte(`{}`))
	require.Error(t, err)
	_, err = cs.Live(context.Background(), LivePausedPath, make([]byte, LiveMaxPaused+1))
	require.Error(t, err)
	_, err = cs.Live(context.Background(), LiveConfirmPath, make([]byte, LiveMaxConfirm+1))
	require.Error(t, err)
	_, err = cs.Live(context.Background(), LiveFramePath, make([]byte, LiveMaxFrame+1))
	require.Error(t, err)
	assert.Equal(t, 0, calls)
}

// The kind table is a census: a connector-opened kind is added here only on purpose, and the hub gets no way to open live toward this side.
func TestTheLiveKindIsTheOnlyNewConnectorOpenedKindAndTheCapsAreClosed(t *testing.T) {
	var names []string
	for _, k := range inboundKinds {
		names = append(names, string(k.kind))
	}
	assert.Equal(t, []string{"relay", "signin", "control", "live"}, names)
	k := inboundKindFor(KindLive)
	require.NotNil(t, k)
	assert.Equal(t, "live_push/1", k.capability)
	assert.Equal(t, 1<<10, k.maxReply)
	assert.Equal(t, 64<<10, k.pathCap(LiveFramePath))
	assert.Equal(t, 256, k.pathCap(LivePausedPath))
	assert.Equal(t, 256, k.pathCap(LiveConfirmPath))
	assert.Equal(t, 0, k.pathCap("/live/v1/anything"))
}

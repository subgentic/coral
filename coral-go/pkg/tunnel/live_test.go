package tunnel

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

// coral-hub Security MUST (#21075): live pushes have their own small in-flight budget (2), as sign-in and control do (#3966), so a burst of pushes never makes a relay request come back busy, and a full relay budget never starves a push.
func TestLiveHasItsOwnInFlightBudgetAndRelayIsUnaffected(t *testing.T) {
	release := make(chan struct{})
	var livesIn, relaysIn atomic.Int32
	cfg := SessionConfig{
		Capabilities: func(any) []string { return []string{CapabilityLive, CapabilityRelay} },
		OnLive: func(ctx context.Context, _ *Session, req LiveRequest) RelayResponse {
			if req.Path == LiveFramePath {
				livesIn.Add(1)
				select {
				case <-release:
				case <-ctx.Done():
				}
			}
			return RelayResponse{Status: 200, Body: []byte(`{"ok":true}`)}
		},
		OnRelay: func(ctx context.Context, _ *Session, _ RelayRequest) RelayResponse {
			relaysIn.Add(1)
			select {
			case <-release:
			case <-ctx.Done():
			}
			return RelayResponse{Status: 200, Body: []byte(`{}`)}
		},
	}
	_, cs := connect(t, newHub(t, cfg), noopLocal(), nil)
	var wg sync.WaitGroup
	defer func() { close(release); wg.Wait() }()
	// A full live budget (2) ...
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = cs.Live(context.Background(), LiveFramePath, []byte(`{}`)) }()
	}
	require.Eventually(t, func() bool { return livesIn.Load() == 2 }, 5*time.Second, 10*time.Millisecond, "the live budget is full")
	// ... leaves the relay's whole budget (4) free: none of its requests is busy.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = cs.Relay(context.Background(), RelayTargetsPath, []byte(`{}`)) }()
	}
	require.Eventually(t, func() bool { return relaysIn.Load() == 4 }, 5*time.Second, 10*time.Millisecond, "a full live budget takes none of the relay's slots")
	// A third live push is answered busy with the fixed body, and the relay budget is then full while a confirm still gets 429 rather than waiting.
	r, err := cs.Live(context.Background(), LiveConfirmPath, []byte(`{}`))
	require.NoError(t, err)
	assert.Equal(t, http.StatusTooManyRequests, r.Status)
	assert.JSONEq(t, `{"error":"rate_limited"}`, string(r.Body))
}

// SHOULD (#21075): a live header carrying any field the Hub stamps is closed unanswered, and the hook never runs.
func TestALiveHeaderWithAHubStampedFieldIsClosedUnanswered(t *testing.T) {
	var calls atomic.Int32
	h := liveHub(t, []string{CapabilityLive}, func(context.Context, *Session, LiveRequest) RelayResponse {
		calls.Add(1)
		return RelayResponse{Status: 200, Body: []byte(`{"ok":true}`)}
	})
	_, cs := connect(t, h, noopLocal(), nil)
	base := func() Header {
		return Header{Kind: KindLive, Method: http.MethodPost, Path: LiveConfirmPath, ContentLength: 2}
	}
	send := func(hdr Header) error {
		st, err := cs.ys.OpenStream()
		require.NoError(t, err)
		defer st.Close()
		_ = st.SetDeadline(time.Now().Add(10 * time.Second))
		require.NoError(t, writeFrame(st, hdr))
		_ = writeRawFrame(st, []byte(`{}`))
		_, err = readFrame(st, 1<<16)
		return err
	}
	require.NoError(t, send(base()), "the plain request is answered")
	stamped := map[string]func(*Header){
		"HubUser": func(h *Header) { h.HubUser = "hub-user-0000000a" }, "HubTier": func(h *Header) { h.HubTier = "launch" },
		"HubRole": func(h *Header) { h.HubRole = "member" }, "GuideBoard": func(h *Header) { h.GuideBoard = "b" },
		"GuideLabel": func(h *Header) { h.GuideLabel = "l" }, "GuideSince": func(h *Header) { h.GuideSince = "2026-01-01" },
		"HubOrg": func(h *Header) { h.HubOrg = "o" }, "HubTeamRole": func(h *Header) { h.HubTeamRole = "admin" },
		"HubUserID": func(h *Header) { h.HubUserID = "u" },
		"Query":     func(h *Header) { h.Query = "a=1" }, "Headers": func(h *Header) { h.Headers = http.Header{"X": {"y"}} },
	}
	before := calls.Load()
	for name, set := range stamped {
		hdr := base()
		set(&hdr)
		assert.Error(t, send(hdr), "%s: closed without an answer", name)
	}
	assert.Equal(t, before, calls.Load(), "OnLive never ran for them")
}

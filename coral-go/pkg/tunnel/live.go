package tunnel

import (
	"context"
	"errors"
	"time"
)

// Coral Live (#21064, design v4 section 1 and 14): a Coral may push a read-only picture of one team (a frame), tell the Hub a link was confirmed, and tell it a link was paused by this computer.
// It is a connector-opened stream of the kind "live", one request each, the same wire as the relay (inbound.go). The Hub advertises "live_push/1" in Welcome only for a tunnel it will take frames from;
// a connector never opens the kind otherwise, and a hub without an OnLive hook closes it at once. There is no Hub-opened route for live: the Hub can only answer, and what it answers is decoded
// strictly by the caller (a closed reply set that only ever turns things off).

// CapabilityLive is the capability a hub advertises when it takes live streams from this tunnel.
const CapabilityLive = "live_push/1"

// KindLive is the stream kind of a connector-opened live request.
const KindLive Kind = "live"

// The only live paths, and their request body caps.
const (
	LiveFramePath   = "/live/v1/frame"
	LiveConfirmPath = "/live/v1/confirm"
	LivePausedPath  = "/live/v1/paused"

	LiveMaxFrame   = 64 << 10
	LiveMaxConfirm = 256
	LiveMaxPaused  = 256
	LiveMaxReply   = 1 << 10
)

func liveCap(path string) int {
	switch path {
	case LiveFramePath:
		return LiveMaxFrame
	case LiveConfirmPath:
		return LiveMaxConfirm
	case LivePausedPath:
		return LiveMaxPaused
	}
	return 0
}

// liveTimeout bounds a whole live request on the connector.
const liveTimeout = 10 * time.Second

var liveKind = &inboundKind{
	kind: KindLive, capability: CapabilityLive, pathCap: liveCap, maxReply: LiveMaxReply, timeout: liveTimeout,
	busy:   []byte(`{"error":"rate_limited"}`),
	failed: []byte(`{"error":"bad_frame"}`),
}

// ErrLiveUnsupported: the hub didn't advertise live_push/1 for this tunnel.
var ErrLiveUnsupported = errors.New("tunnel: Coral Hub doesn't take live pushes for this server")

// LiveRequest is what the hub's OnLive hook gets: the path (one of the three live paths) and the body, already within its cap. The source computer is the Session's identity, never anything in the body.
type LiveRequest struct {
	Path string
	Body []byte
}

// LiveFunc handles one live request on the hub. It must check the account, the link and its state on every call.
type LiveFunc func(ctx context.Context, s *Session, req LiveRequest) RelayResponse

// CanLive reports whether the hub advertised live_push/1 for this tunnel.
func (c *ClientSession) CanLive() bool { return c.advertised(CapabilityLive) }

// Live sends one live request (a frame, a confirm or a paused message) and returns the hub's answer. It fails with ErrLiveUnsupported when the hub didn't advertise the capability.
func (c *ClientSession) Live(ctx context.Context, path string, body []byte) (RelayResponse, error) {
	return c.callInbound(ctx, liveKind, path, body, ErrLiveUnsupported)
}

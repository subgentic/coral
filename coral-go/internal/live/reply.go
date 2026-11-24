package live

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
)

// The Hub's answer to a push is decoded strictly (design 1 and 14.3): a closed set, an unknown key, a second value, a body over 1 KiB or an out-of-range number is a protocol error, and nothing in a reply ever widens anything.

// Paths are the three live request paths (pkg/tunnel/live.go has the same strings; the pusher's Transport is given them).
const (
	PathFrame   = "/live/v1/frame"
	PathConfirm = "/live/v1/confirm"
	PathPaused  = "/live/v1/paused"
)

// MaxReply is the largest reply body.
const MaxReply = 1 << 10

// MaxLastViewedS is 31 days.
const MaxLastViewedS = 31 * 24 * 3600

// Reply is a decoded Hub answer.
type Reply struct {
	OK          bool
	NotLive     bool
	Stop        bool
	Pause       bool
	RateLimited bool
	BadFrame    bool
	LastViewedS *int64
}

// ErrProtocol is a reply outside the closed set.
var ErrProtocol = errors.New("live: the Hub's reply is outside the agreed set")

var uintRE = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

// DecodeReply reads the Hub's answer to a request on path.
func DecodeReply(path string, b []byte) (Reply, error) {
	if len(b) == 0 || len(b) > MaxReply || (path != PathFrame && path != PathConfirm && path != PathPaused) {
		return Reply{}, ErrProtocol
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return Reply{}, ErrProtocol
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		kt, err := dec.Token()
		key, ok := kt.(string)
		if err != nil || !ok {
			return Reply{}, ErrProtocol
		}
		if _, dup := fields[key]; dup {
			return Reply{}, ErrProtocol
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return Reply{}, ErrProtocol
		}
		fields[key] = raw
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return Reply{}, ErrProtocol
	}
	if _, err := dec.Token(); err != io.EOF {
		return Reply{}, ErrProtocol // a second value, or anything after
	}
	isTrue := func(k string) bool { return string(fields[k]) == "true" }
	frame := path == PathFrame
	switch len(fields) {
	case 1:
		switch {
		case isTrue("ok"):
			return Reply{OK: true}, nil
		case isTrue("stop") && frame:
			return Reply{Stop: true}, nil
		case isTrue("pause") && frame:
			return Reply{Pause: true}, nil
		case string(fields["outcome"]) == `"not_live"`:
			return Reply{NotLive: true}, nil
		case string(fields["error"]) == `"rate_limited"`:
			return Reply{RateLimited: true}, nil
		case string(fields["error"]) == `"bad_frame"` && path != PathPaused:
			return Reply{BadFrame: true}, nil
		}
	case 2:
		raw, has := fields["last_viewed_age_s"]
		if frame && isTrue("ok") && has && uintRE.Match(raw) {
			n, err := strconv.ParseInt(string(raw), 10, 64)
			if err == nil && n >= 0 && n <= MaxLastViewedS {
				return Reply{OK: true, LastViewedS: &n}, nil
			}
		}
	}
	return Reply{}, ErrProtocol
}

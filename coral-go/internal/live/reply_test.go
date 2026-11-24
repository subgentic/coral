package live

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTheClosedReplySetDecodes(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	for _, c := range []struct {
		path, body string
		want       Reply
	}{
		{PathFrame, `{"ok":true}`, Reply{OK: true}},
		{PathFrame, `{"ok":true,"last_viewed_age_s":0}`, Reply{OK: true, LastViewedS: n(0)}},
		{PathFrame, `{"last_viewed_age_s":2678400,"ok":true}`, Reply{OK: true, LastViewedS: n(2678400)}},
		{PathFrame, `{"outcome":"not_live"}`, Reply{NotLive: true}},
		{PathFrame, `{"stop":true}`, Reply{Stop: true}},
		{PathFrame, `{"pause":true}`, Reply{Pause: true}},
		{PathFrame, `{"error":"rate_limited"}`, Reply{RateLimited: true}},
		{PathFrame, `{"error":"bad_frame"}`, Reply{BadFrame: true}},
		{PathConfirm, `{"ok":true}`, Reply{OK: true}},
		{PathConfirm, `{"error":"bad_frame"}`, Reply{BadFrame: true}},
		{PathPaused, `{"outcome":"not_live"}`, Reply{NotLive: true}},
		{PathPaused, ` {"ok":true} `, Reply{OK: true}},
	} {
		got, err := DecodeReply(c.path, []byte(c.body))
		require.NoError(t, err, c.body)
		require.Equal(t, c.want, got, c.body)
	}
}

func TestAnythingOutsideTheReplySetIsAProtocolError(t *testing.T) {
	for _, c := range []struct{ path, body string }{
		{PathFrame, ``},
		{PathFrame, `null`},
		{PathFrame, `[]`},
		{PathFrame, `{}`},
		{PathFrame, `{"ok":false}`},
		{PathFrame, `{"ok":"true"}`},
		{PathFrame, `{"ok":true,"viewers":3}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":-1}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":2678401}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":1.5}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":1e3}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":"5"}`},
		{PathFrame, `{"ok":true,"last_viewed_age_s":01}`},
		{PathFrame, `{"ok":true,"ok":true}`},
		{PathFrame, `{"ok":true}{"ok":true}`},
		{PathFrame, `{"ok":true} x`},
		{PathFrame, `{"stop":true,"ok":true}`},
		{PathFrame, `{"outcome":"live"}`},
		{PathFrame, `{"error":"anything else"}`},
		{PathFrame, `{"resume":true}`},
		{PathFrame, `{"seq":5}`},
		{PathConfirm, `{"stop":true}`},
		{PathConfirm, `{"pause":true}`},
		{PathConfirm, `{"ok":true,"last_viewed_age_s":5}`},
		{PathPaused, `{"error":"bad_frame"}`},
		{PathPaused, `{"ok":true,"last_viewed_age_s":5}`},
		{"/live/v1/other", `{"ok":true}`},
		{PathFrame, `{"ok":true,"x":"` + strings.Repeat("a", MaxReply) + `"}`},
	} {
		_, err := DecodeReply(c.path, []byte(c.body))
		require.ErrorIs(t, err, ErrProtocol, "%s %.60s", c.path, c.body)
	}
}

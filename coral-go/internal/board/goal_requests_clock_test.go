package board

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setGoalRequestClockForTest makes the request expiry read now instead of the real clock; the returned function puts the real one back. It lives in a test file so no production build carries a way to move
// the clock (#12927; #12925 had it exported from goal_requests.go).
func setGoalRequestClockForTest(now func() time.Time) (restore func()) {
	goalRequestClock.Store(&now)
	return func() { goalRequestClock.Store(nil) }
}

// The expiry reads the store's clock, not a date a test was written on: a request sent now is open on the real clock, still open when the clock is a year or two BEHIND (the fixed date of a test written long ago
// is that), and expired once the clock is past the TTL, one or two years ahead (the day a fixed-date test would have started to fail, #12927).
func TestGoalRequestExpiryReadsTheStoresClock(t *testing.T) {
	for _, tc := range []struct {
		name    string
		shift   time.Duration
		expired bool
	}{
		{"the real clock", 0, false},
		{"a year behind", -365 * 24 * time.Hour, false},
		{"just inside the TTL", GoalRequestTTL - time.Hour, false},
		{"just past the TTL", GoalRequestTTL + time.Hour, true},
		{"a year ahead", 365 * 24 * time.Hour, true},
		{"two years ahead", 730 * 24 * time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ctx, g := requestEnv(t)
			_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead", nil)
			require.NoError(t, err)
			defer setGoalRequestClockForTest(func() time.Time { return time.Now().Add(tc.shift) })()
			_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "t", "", "medium", "Orch B", "")
			if tc.expired {
				assert.ErrorIs(t, err, ErrGoalRequestExpired)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

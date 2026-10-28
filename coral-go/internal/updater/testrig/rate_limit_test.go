package testrig

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

const listKey = "repos/" + FakeRepo + "/releases"

func nextAttempt(t *testing.T, res stage.Result) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, res.NextAttempt)
	require.NoError(t, err, "next_attempt %q", res.NextAttempt)
	return at
}

// GitHub's limit on anonymous requests (#9704): a 403 whose x-ratelimit-remaining is 0 makes the check wait until x-ratelimit-reset, once, and not ask again before it; after it the check goes on as usual.
func TestCheckWaitsUntilTheRateLimitIsOver(t *testing.T) {
	r := newRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	now := t0
	r.cfg.Now = func() time.Time { return now }
	reset := t0.Add(20 * time.Minute)
	r.gh.Status["list"] = 403
	r.gh.Headers = map[string]map[string]string{"list": {"X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "60", "X-RateLimit-Reset": strconv.FormatInt(reset.Unix(), 10)}}

	res := r.check()
	require.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
	assert.Equal(t, "manifest", res.FailedStage)
	assert.Equal(t, reset.Add(10*time.Second), nextAttempt(t, res), "the next attempt is when GitHub says the limit is over, and a few seconds more")
	st, err := verify.LoadState(r.cfg.DataDir + "/" + stage.UpdatesDir)
	require.NoError(t, err)
	require.NotNil(t, st.Stage)
	assert.Equal(t, stage.KindRateLimit, st.Stage.ErrorKind)
	hits := r.gh.Hits[listKey]

	now = t0.Add(10 * time.Minute) // still limited
	res = r.check()
	assert.Equal(t, stage.ResultBackoff, res.Result, "no new request while the limit is on: %+v", res)
	assert.Equal(t, hits, r.gh.Hits[listKey], "GitHub was not asked again")

	now = reset.Add(time.Minute) // over
	delete(r.gh.Status, "list")
	res = r.check()
	assert.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
}

// Retry-After says it in seconds (or a date); a 429 is the limit too; an answer that says nothing about when waits an hour; a 403 that is not about the quota is a plain failure.
func TestRateLimitAnswersAndTheirWaits(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name    string
		status  int
		headers map[string]string
		kind    string
		least   time.Duration
		most    time.Duration
	}{
		{"429 with Retry-After seconds", 429, map[string]string{"Retry-After": "600"}, stage.KindRateLimit, 600 * time.Second, 630 * time.Second},
		{"403 with Retry-After seconds", 403, map[string]string{"Retry-After": "120"}, stage.KindRateLimit, time.Minute, 150 * time.Second},
		{"Retry-After as a date", 429, map[string]string{"Retry-After": now.Add(30 * time.Minute).Format("Mon, 02 Jan 2006 15:04:05 GMT")}, stage.KindRateLimit, 29 * time.Minute, 31 * time.Minute},
		{"429 that says nothing about when", 429, nil, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"403 with the quota spent and no reset", 403, map[string]string{"X-RateLimit-Remaining": "0"}, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"a reset in the past waits the least", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(now.Add(-time.Hour).Unix(), 10)}, stage.KindRateLimit, time.Minute, time.Minute + time.Second},
		{"a reset far away is a day at most", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(now.Add(72*time.Hour).Unix(), 10)}, stage.KindRateLimit, 24 * time.Hour, 24*time.Hour + time.Second},
		{"Retry-After of 99999999999999 says nothing", 429, map[string]string{"Retry-After": "99999999999999"}, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"Retry-After of 2147483648 (2^31) says nothing", 429, map[string]string{"Retry-After": "2147483648"}, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"a reset of 1<<41 says nothing", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(1<<41, 10)}, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"a header that is not a number says nothing", 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "tomorrow", "Retry-After": "soon"}, stage.KindRateLimit, time.Hour, time.Hour + time.Second},
		{"a 403 with quota left is a plain failure", 403, map[string]string{"X-RateLimit-Remaining": "12"}, stage.KindNetwork, 5 * time.Minute, 5*time.Minute + time.Second},
		{"a 500 is a plain failure", 500, map[string]string{"Retry-After": "600"}, stage.KindNetwork, 5 * time.Minute, 5*time.Minute + time.Second},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.cfg.Now = time.Now
			r.gh.Status["list"] = c.status
			r.gh.Headers = map[string]map[string]string{"list": c.headers}
			start := time.Now()
			res := r.check()
			require.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
			wait := nextAttempt(t, res).Sub(start)
			assert.GreaterOrEqual(t, wait, c.least-5*time.Second, "waits at least %v: %v", c.least, wait)
			assert.LessOrEqual(t, wait, c.most+5*time.Second, "waits at most %v: %v", c.most, wait)
			st, err := verify.LoadState(r.cfg.DataDir + "/" + stage.UpdatesDir)
			require.NoError(t, err)
			require.NotNil(t, st.Stage)
			assert.Equal(t, c.kind, st.Stage.ErrorKind)
		})
	}
}

// A clock ahead of GitHub's sees every reset as already past: the floor doubles with each rate limit in a row (1, 2, 4 minutes, ... at most a day), so it does not ask every minute for good; another kind of
// failure in between starts the count again.
func TestTheFloorOfTheWaitDoublesWithEachRateLimitInARow(t *testing.T) {
	r := newRig(t)
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	r.cfg.Now = func() time.Time { return now }
	r.gh.Status["list"] = 403
	r.gh.Headers = map[string]map[string]string{"list": {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(now.Add(-time.Hour).Unix(), 10)}} // already past
	wait := func() time.Duration {
		res := r.check()
		require.Equal(t, stage.ResultFailed, res.Result, "%+v", res)
		next := nextAttempt(t, res)
		d := next.Sub(now)
		now = next
		return d
	}
	for i, want := range []time.Duration{1, 2, 4, 8, 16} {
		assert.Equal(t, want*time.Minute, wait(), "rate limit %d in a row", i+1)
	}
	for i := 0; i < 12; i++ {
		wait()
	}
	assert.Equal(t, 24*time.Hour, wait(), "a day at most")

	// a plain failure in between starts the count again
	r.gh.Status["list"] = 500
	r.gh.Headers = nil
	assert.Equal(t, 5*time.Minute, wait(), "a network failure: its own back-off")
	r.gh.Status["list"] = 403
	r.gh.Headers = map[string]map[string]string{"list": {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(now.Add(-time.Hour).Unix(), 10)}}
	assert.Equal(t, time.Minute, wait(), "the first rate limit after it")
}

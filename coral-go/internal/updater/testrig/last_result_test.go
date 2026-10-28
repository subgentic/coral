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

func lastResult(t *testing.T, r *rig) *verify.CheckResult {
	t.Helper()
	st, err := verify.LoadState(r.cfg.DataDir + "/" + stage.UpdatesDir)
	require.NoError(t, err)
	return st.LastResult
}

// Each check keeps what it found, for Settings and the dashboard's notice (#9726): the result word, the newest product release it saw, the stage of a failure and when.
func TestEachCheckRecordsWhatItFound(t *testing.T) {
	at := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

	t.Run("up to date, from the feed alone", func(t *testing.T) {
		r := newRig(t)
		r.cfg.Now = func() time.Time { return at }
		r.publish(Spec{Version: installed, Sequence: 7})
		r.gh.FeedExtra = []string{"v1.4.131-rc1"}
		require.Equal(t, stage.ResultUpToDate, r.check().Result)
		assert.Equal(t, &verify.CheckResult{Result: "up_to_date", Newest: installed, At: at.Format(time.RFC3339)}, lastResult(t, r))
	})
	t.Run("staged", func(t *testing.T) {
		r := newRig(t)
		r.cfg.Now = func() time.Time { return at }
		r.publish(Spec{Version: "1.4.131", Sequence: 7})
		require.Equal(t, stage.ResultStaged, r.check().Result)
		assert.Equal(t, &verify.CheckResult{Result: "staged", Newest: "1.4.131", At: at.Format(time.RFC3339)}, lastResult(t, r))
	})
	t.Run("a newer release that is not promoted yet", func(t *testing.T) {
		r := newRig(t)
		r.cfg.Now = func() time.Time { return at }
		r.gh.FeedExtra = []string{"v1.4.140"}
		r.gh.ListBody = []byte(`[{"tag_name":"v1.4.140","draft":false,"prerelease":false,"assets":[]}]`)
		require.Equal(t, stage.ResultNotPromoted, r.check().Result)
		assert.Equal(t, &verify.CheckResult{Result: "not_promoted", Newest: "1.4.140", At: at.Format(time.RFC3339)}, lastResult(t, r))
	})
	t.Run("a rate limit", func(t *testing.T) {
		r := newRig(t)
		r.cfg.Now = func() time.Time { return at }
		r.gh.FeedExtra = []string{"v1.4.140"}
		r.gh.Status["list"] = 403
		r.gh.Headers = map[string]map[string]string{"list": {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(at.Add(20*time.Minute).Unix(), 10)}}
		require.Equal(t, stage.ResultFailed, r.check().Result)
		assert.Equal(t, &verify.CheckResult{Result: "rate_limited", Newest: "1.4.140", Stage: "manifest", At: at.Format(time.RFC3339)}, lastResult(t, r), "the newest seen in the feed is kept")
	})
	t.Run("a failure", func(t *testing.T) {
		r := newAPIRig(t)
		r.cfg.Now = func() time.Time { return at }
		r.gh.Status["list"] = 503
		require.Equal(t, stage.ResultFailed, r.check().Result)
		assert.Equal(t, &verify.CheckResult{Result: "failed", Stage: "manifest", At: at.Format(time.RFC3339)}, lastResult(t, r))
	})
	t.Run("a check that did not run keeps the last record", func(t *testing.T) {
		r := newRig(t)
		now := at
		r.cfg.Now = func() time.Time { return now }
		r.publish(Spec{Version: installed, Sequence: 7})
		require.Equal(t, stage.ResultUpToDate, r.check().Result)
		first := lastResult(t, r)
		r.gh.Status["feed"] = 500
		r.gh.Status["list"] = 403
		r.gh.Headers = map[string]map[string]string{"list": {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(at.Add(time.Hour).Unix(), 10)}}
		now = at.Add(time.Minute)
		require.Equal(t, stage.ResultFailed, r.check().Result)
		now = at.Add(2 * time.Minute) // inside the wait: nothing is asked, nothing recorded
		require.Equal(t, stage.ResultBackoff, r.check().Result)
		got := lastResult(t, r)
		assert.Equal(t, "rate_limited", got.Result, "the backoff answer did not overwrite it: %+v vs %+v", got, first)
		assert.Equal(t, at.Add(time.Minute).Format(time.RFC3339), got.At)
	})
}

package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newCheck(name string) HealthCheck {
	return HealthCheck{Project: "team", Name: name, ScriptSrc: "/x/s.sh", ScriptHash: "h1", Snapshot: "/snap/h1", Args: []string{"--a"}, Every: "30m", To: "Dev", ActsAs: "Dev One"}
}

func TestACheckIsPendingAndNeverDueUntilApproved(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	c, err := s.AddHealthCheck(ctx, newCheck("stale-prs"), now)
	require.NoError(t, err)
	assert.Equal(t, CheckPending, c.State)
	due, err := s.DueHealthChecks(ctx, now.Add(24*time.Hour))
	require.NoError(t, err)
	assert.Empty(t, due, "a pending check never runs")

	// Approval of a record that is not the stored one is refused (the check changed after it was shown).
	assert.ErrorIs(t, s.ApproveHealthCheck(ctx, "team", "stale-prs", "Operator", "not-the-hash", now), ErrCheckRecord)
	assert.ErrorIs(t, s.ApproveHealthCheck(ctx, "team", "stale-prs", "Operator", "", now), ErrCheckRecord)
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "stale-prs", "Operator", c.RecordHash(), now))
	due, _ = s.DueHealthChecks(ctx, now)
	require.Len(t, due, 1)
	assert.True(t, due[0].Approved())
	assert.Equal(t, "Operator", due[0].ApprovedBy)
}

func TestAnyChangeToTheRecordMakesItPendingAgain(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	c, _ := s.AddHealthCheck(ctx, newCheck("a"), now)
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "a", "Operator", c.RecordHash(), now))
	for name, mut := range map[string]func(*HealthCheck){
		"script": func(c *HealthCheck) { c.ScriptHash = "h2" },
		"args":   func(c *HealthCheck) { c.Args = []string{"--b"} },
		"dir":    func(c *HealthCheck) { c.Dir = "/team" },
		"every":  func(c *HealthCheck) { c.Every = "1h" },
		"to":     func(c *HealthCheck) { c.To = "Other" },
		"acts":   func(c *HealthCheck) { c.ActsAs = "Other One" },
	} {
		require.NoError(t, s.ApproveHealthCheck(ctx, "team", "a", "Operator", mustGet(t, s, "a").RecordHash(), now), name)
		got, err := s.ChangeHealthCheck(ctx, "team", "a", mut)
		require.NoError(t, err, name)
		assert.Equal(t, CheckPending, got.State, name)
		assert.Empty(t, got.ApprovedHash, name)
		due, _ := s.DueHealthChecks(ctx, now.Add(time.Hour))
		assert.Empty(t, due, name)
		// Put the original back: the old approval does not come back with it.
		_, _ = s.ChangeHealthCheck(ctx, "team", "a", func(c *HealthCheck) { *c = newCheckLike(*c, newCheck("a")) })
	}
}

func newCheckLike(cur, base HealthCheck) HealthCheck {
	base.ID, base.State, base.ApprovedBy, base.ApprovedHash, base.CreatedAt = cur.ID, cur.State, cur.ApprovedBy, cur.ApprovedHash, cur.CreatedAt
	return base
}

func mustGet(t *testing.T, s *Store, name string) HealthCheck {
	t.Helper()
	c, err := s.GetHealthCheck(context.Background(), "team", name)
	require.NoError(t, err)
	return c
}

func TestAddRefusesBadNamesSchedulesDuplicatesAndTheEleventh(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Now()
	bad := newCheck("Bad Name")
	_, err := s.AddHealthCheck(ctx, bad, now)
	assert.Error(t, err)
	fast := newCheck("fast")
	fast.Every = "1m"
	_, err = s.AddHealthCheck(ctx, fast, now)
	assert.Error(t, err, "under 5 minutes")
	_, err = s.AddHealthCheck(ctx, newCheck("one"), now)
	require.NoError(t, err)
	_, err = s.AddHealthCheck(ctx, newCheck("one"), now)
	assert.ErrorIs(t, err, ErrCheckExists)
	for i := 1; i < MaxHealthChecksPerBoard; i++ {
		_, err = s.AddHealthCheck(ctx, newCheck("c"+string(rune('a'+i))), now)
		require.NoError(t, err)
	}
	_, err = s.AddHealthCheck(ctx, newCheck("eleven"), now)
	assert.ErrorIs(t, err, ErrCheckLimit)
	other := newCheck("one")
	other.Project = "other"
	_, err = s.AddHealthCheck(ctx, other, now)
	assert.NoError(t, err, "the limit and the names are per board")
}

func TestAFailureIsSaidOnceAndFiveInARowPause(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	c, _ := s.AddHealthCheck(ctx, newCheck("f"), now)
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "f", "Operator", c.RecordHash(), now))
	fail := HealthCheckRun{At: now, Exit: 2, Failed: true}
	say, paused, err := s.RecordHealthCheckRun(ctx, mustGet(t, s, "f"), fail)
	require.NoError(t, err)
	assert.True(t, say, "the first failure is said")
	assert.False(t, paused)
	for i := 2; i <= 4; i++ {
		say, paused, _ = s.RecordHealthCheckRun(ctx, mustGet(t, s, "f"), fail)
		assert.False(t, say, "said once until it recovers")
		assert.False(t, paused)
	}
	say, paused, _ = s.RecordHealthCheckRun(ctx, mustGet(t, s, "f"), fail)
	assert.True(t, paused, "five in a row")
	assert.Equal(t, CheckPaused, mustGet(t, s, "f").State)
	// A recovery clears it: the next failure is said again.
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "f", "Operator", mustGet(t, s, "f").RecordHash(), now))
	_, _, _ = s.RecordHealthCheckRun(ctx, mustGet(t, s, "f"), HealthCheckRun{At: now})
	say, _, _ = s.RecordHealthCheckRun(ctx, mustGet(t, s, "f"), fail)
	assert.True(t, say)
}

func TestKeysAreSaidOnceAgainWhenTheyComeBackOrAfterRenag(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	c, _ := s.AddHealthCheck(ctx, newCheck("k"), now)
	fresh, err := s.NoteHealthCheckKeys(ctx, c.ID, []string{"a", "b"}, now, 0)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"a", "b"}, fresh)
	fresh, _ = s.NoteHealthCheckKeys(ctx, c.ID, []string{"a", "b"}, now.Add(time.Hour), 0)
	assert.Empty(t, fresh, "said once")
	fresh, _ = s.NoteHealthCheckKeys(ctx, c.ID, []string{"a"}, now.Add(2*time.Hour), 0)
	assert.Empty(t, fresh, "b is absent now")
	fresh, _ = s.NoteHealthCheckKeys(ctx, c.ID, []string{"a", "b"}, now.Add(3*time.Hour), 0)
	assert.Equal(t, []string{"b"}, fresh, "b came back")
	fresh, _ = s.NoteHealthCheckKeys(ctx, c.ID, []string{"a", "b"}, now.Add(30*time.Hour), HealthCheckRenag)
	assert.ElementsMatch(t, []string{"a", "b"}, fresh, "a was said 30 h ago and b 27 h ago: both are over 24 h")
}

func TestOneChecksKeysDoNotSilenceAnotherChecks(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Now()
	a, _ := s.AddHealthCheck(ctx, newCheck("a"), now)
	b, _ := s.AddHealthCheck(ctx, newCheck("b"), now)
	_, _ = s.NoteHealthCheckKeys(ctx, a.ID, []string{"same"}, now, 0)
	fresh, _ := s.NoteHealthCheckKeys(ctx, b.ID, []string{"same"}, now, 0)
	assert.Equal(t, []string{"same"}, fresh)
}

func TestAtMost100KeysAreKept(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Now()
	c, _ := s.AddHealthCheck(ctx, newCheck("many"), now)
	var keys []string
	for i := 0; i < 150; i++ {
		keys = append(keys, "k"+time.Duration(i).String())
	}
	fresh, err := s.NoteHealthCheckKeys(ctx, c.ID, keys, now, 0)
	require.NoError(t, err)
	assert.Len(t, fresh, MaxHealthCheckKeys)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM health_check_keys WHERE check_id = ?`, c.ID))
	assert.Equal(t, MaxHealthCheckKeys, n)
}

func TestPauseAndResumeKeepTheApproval(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Now()
	c, _ := s.AddHealthCheck(ctx, newCheck("p"), now)
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "p", "Operator", c.RecordHash(), now))
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "p", true, now))
	due, _ := s.DueHealthChecks(ctx, now.Add(time.Hour))
	assert.Empty(t, due, "paused")
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "p", false, now))
	assert.Equal(t, CheckApproved, mustGet(t, s, "p").State, "the same record is still approved")
	_, _ = s.ChangeHealthCheck(ctx, "team", "p", func(c *HealthCheck) { c.ScriptHash = "h9" })
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "p", true, now))
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "p", false, now))
	assert.Equal(t, CheckPending, mustGet(t, s, "p").State, "a changed check does not come back approved")
}

func TestRemoveDeletesTheCheckAndItsKeys(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Now()
	c, _ := s.AddHealthCheck(ctx, newCheck("r"), now)
	_, _ = s.NoteHealthCheckKeys(ctx, c.ID, []string{"a"}, now, 0)
	require.NoError(t, s.RemoveHealthCheck(ctx, "team", "r"))
	_, err := s.GetHealthCheck(ctx, "team", "r")
	assert.ErrorIs(t, err, ErrCheckMissing)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM health_check_keys WHERE check_id = ?`, c.ID))
	assert.Zero(t, n)
}

func TestAPauseDuringARunStaysPaused(t *testing.T) {
	s, ctx, now := testStore(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	c, _ := s.AddHealthCheck(ctx, newCheck("race"), now)
	require.NoError(t, s.ApproveHealthCheck(ctx, "team", "race", "Operator", c.RecordHash(), now))
	inFlight := mustGet(t, s, "race") // the copy the run started with: approved
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "race", true, now))
	_, _, err := s.RecordHealthCheckRun(ctx, inFlight, HealthCheckRun{At: now})
	require.NoError(t, err)
	assert.Equal(t, CheckPaused, mustGet(t, s, "race").State, "the run's stale copy did not put it back to approved")
	// A change made during the run stays pending too, and a removed check is not brought back.
	require.NoError(t, s.PauseHealthCheck(ctx, "team", "race", false, now))
	inFlight = mustGet(t, s, "race")
	_, _ = s.ChangeHealthCheck(ctx, "team", "race", func(c *HealthCheck) { c.ScriptHash = "h-new" })
	_, _, _ = s.RecordHealthCheckRun(ctx, inFlight, HealthCheckRun{At: now, Failed: true})
	assert.Equal(t, CheckPending, mustGet(t, s, "race").State)
	require.NoError(t, s.RemoveHealthCheck(ctx, "team", "race"))
	_, _, err = s.RecordHealthCheckRun(ctx, inFlight, HealthCheckRun{At: now})
	assert.NoError(t, err)
	_, err = s.GetHealthCheck(ctx, "team", "race")
	assert.ErrorIs(t, err, ErrCheckMissing)
}

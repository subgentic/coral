package limitwaits

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openT(t *testing.T) (*Store, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "limit_waits.db")
	s, err := Open(p)
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s, p
}

var utc = time.UTC

func at(day, hh, mm int) time.Time { return time.Date(2026, 11, day, hh, mm, 0, 0, utc) }

// wait records one wait that starts at `start` and ends as `kind` ("" leaves it open).
func wait(t *testing.T, s *Store, agent, team string, start time.Time, kind string) {
	t.Helper()
	id, err := s.Begin(Wait{SessionID: "sid-" + agent, Agent: agent, Team: team, Vendor: "claude", StartedAt: start, ResetAt: start.Add(time.Hour)})
	require.NoError(t, err)
	if kind != "" {
		require.NoError(t, s.End(id, start.Add(time.Hour), kind))
	}
}

// The scripted run of the approved mock (#21017): 7 waits, 5 resumed at reset, 2 early, over four agent-days.
func scriptedRun(t *testing.T, s *Store) {
	for i := 0; i < 2; i++ {
		wait(t, s, "Lead Developer", "alpha", at(23, 9+i, 0), EndedAtReset)
	}
	wait(t, s, "Lead Developer", "alpha", at(23, 13, 0), EndedEarly)
	wait(t, s, "QA Engineer", "alpha", at(23, 10, 0), EndedAtReset)
	wait(t, s, "QA Engineer", "alpha", at(23, 15, 0), EndedAtReset)
	wait(t, s, "Lead Developer", "alpha", at(22, 8, 0), EndedAtReset)
	wait(t, s, "Lead Developer", "alpha", at(22, 14, 0), EndedEarly)
}

func TestTheCountsMatchAScriptedRunPerAgentAndDay(t *testing.T) {
	s, _ := openT(t)
	scriptedRun(t, s)
	rep, err := s.Counts(at(18, 0, 0), at(25, 0, 0), "", utc)
	require.NoError(t, err)
	assert.Equal(t, Totals{Waits: 7, AtReset: 5, Early: 2}, rep.Totals)
	assert.Equal(t, []Row{
		{Agent: "Lead Developer", Day: "2026-11-23", Waits: 3, AtReset: 2, Early: 1},
		{Agent: "QA Engineer", Day: "2026-11-23", Waits: 2, AtReset: 2, Early: 0},
		{Agent: "Lead Developer", Day: "2026-11-22", Waits: 2, AtReset: 1, Early: 1},
	}, rep.Rows, "newest day first, then the agent with more waits")
	assert.Equal(t, 0, rep.Waiting)
}

func TestAWaitThatHasNotEndedIsCountedAsAWaitAndAsNeitherKindOfResume(t *testing.T) {
	s, _ := openT(t)
	wait(t, s, "Lead Developer", "alpha", at(23, 9, 0), EndedAtReset)
	wait(t, s, "Lead Developer", "alpha", at(23, 12, 0), "") // still waiting
	rep, err := s.Counts(at(23, 0, 0), at(24, 0, 0), "", utc)
	require.NoError(t, err)
	assert.Equal(t, Totals{Waits: 2, AtReset: 1, Early: 0}, rep.Totals)
	assert.Equal(t, 1, rep.Waiting, "one of them is still waiting")
}

func TestAnAgentThatWentAwayWhileItWaitedIsNeitherAResumeAtResetNorAnEarlyOne(t *testing.T) {
	s, _ := openT(t)
	wait(t, s, "Backend Dev", "alpha", at(23, 9, 0), EndedGone)
	rep, err := s.Counts(at(23, 0, 0), at(24, 0, 0), "", utc)
	require.NoError(t, err)
	assert.Equal(t, Totals{Waits: 1}, rep.Totals)
	assert.Equal(t, 0, rep.Waiting, "it is not waiting any more")
}

func TestTheTeamFilterKeepsOneTeamsWaits(t *testing.T) {
	s, _ := openT(t)
	wait(t, s, "Lead Developer", "alpha", at(23, 9, 0), EndedAtReset)
	wait(t, s, "Lead Developer", "beta", at(23, 10, 0), EndedEarly)
	wait(t, s, "Orchestrator", "beta", at(23, 11, 0), EndedAtReset)
	all, _ := s.Counts(at(23, 0, 0), at(24, 0, 0), "", utc)
	assert.Equal(t, 3, all.Totals.Waits)
	rep, err := s.Counts(at(23, 0, 0), at(24, 0, 0), "beta", utc)
	require.NoError(t, err)
	assert.Equal(t, Totals{Waits: 2, AtReset: 1, Early: 1}, rep.Totals)
	assert.Len(t, rep.Rows, 2)
	assert.Equal(t, []string{"alpha", "beta"}, rep.Teams, "the teams of the range, whichever one was asked for")
	none, err := s.Counts(at(23, 0, 0), at(24, 0, 0), "nobody", utc)
	require.NoError(t, err)
	assert.Equal(t, Totals{}, none.Totals)
	assert.NotNil(t, none.Rows, "an empty range has an empty list, not null")
}

func TestTheDayIsTheLocalDayOfTheWaitsStart(t *testing.T) {
	s, _ := openT(t)
	wait(t, s, "Lead Developer", "alpha", at(23, 23, 30), EndedAtReset) // 23:30 UTC: 01:30 on the 24th two hours east
	east := time.FixedZone("east", 2*3600)
	rep, err := s.Counts(at(22, 0, 0), at(26, 0, 0), "", east)
	require.NoError(t, err)
	require.Len(t, rep.Rows, 1)
	assert.Equal(t, "2026-11-24", rep.Rows[0].Day)
	rep, err = s.Counts(at(22, 0, 0), at(26, 0, 0), "", utc)
	require.NoError(t, err)
	assert.Equal(t, "2026-11-23", rep.Rows[0].Day)
}

func TestTheRangeIsFromInclusiveToExclusiveOnTheStart(t *testing.T) {
	s, _ := openT(t)
	wait(t, s, "A", "t", at(23, 0, 0), EndedAtReset)   // at from: in
	wait(t, s, "B", "t", at(24, 0, 0), EndedAtReset)   // at to: out
	wait(t, s, "C", "t", at(22, 23, 59), EndedAtReset) // before from: out
	rep, err := s.Counts(at(23, 0, 0), at(24, 0, 0), "", utc)
	require.NoError(t, err)
	require.Len(t, rep.Rows, 1)
	assert.Equal(t, "A", rep.Rows[0].Agent)
}

func TestEndClosesOnlyAnOpenWaitOnce(t *testing.T) {
	s, _ := openT(t)
	id, err := s.Begin(Wait{SessionID: "s", Agent: "A", Team: "t", Vendor: "claude", StartedAt: at(23, 9, 0), ResetAt: at(23, 10, 0)})
	require.NoError(t, err)
	require.NoError(t, s.End(id, at(23, 10, 5), EndedAtReset))
	require.NoError(t, s.End(id, at(23, 11, 0), EndedEarly)) // too late: it is closed
	rep, _ := s.Counts(at(23, 0, 0), at(24, 0, 0), "", utc)
	assert.Equal(t, Totals{Waits: 1, AtReset: 1}, rep.Totals)
}

func TestOpenReturnsTheWaitsThatHaveNotEndedAfterTheFileIsOpenedAgain(t *testing.T) {
	s, p := openT(t)
	wait(t, s, "Closed One", "t", at(23, 8, 0), EndedAtReset)
	id, err := s.Begin(Wait{SessionID: "sid-open", Agent: "Open One", Team: "t", Vendor: "codex", StartedAt: at(23, 9, 0), ResetAt: at(23, 12, 0)})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	s2, err := Open(p)
	require.NoError(t, err)
	defer s2.Close()
	open, err := s2.Open()
	require.NoError(t, err)
	require.Len(t, open, 1)
	assert.Equal(t, Wait{ID: id, SessionID: "sid-open", Agent: "Open One", Team: "t", Vendor: "codex", StartedAt: at(23, 9, 0), ResetAt: at(23, 12, 0)}, open[0])
}

func TestWaitsOlderThanKeepDaysAreRemovedWhenTheFileIsOpened(t *testing.T) {
	s, p := openT(t)
	old := time.Now().Add(-(KeepDays + 2) * 24 * time.Hour)
	fresh := time.Now().Add(-24 * time.Hour)
	wait(t, s, "Old", "t", old, EndedAtReset)
	wait(t, s, "Fresh", "t", fresh, EndedAtReset)
	require.NoError(t, s.Close())
	s2, err := Open(p)
	require.NoError(t, err)
	defer s2.Close()
	rep, err := s2.Counts(old.Add(-time.Hour), time.Now().Add(time.Hour), "", utc)
	require.NoError(t, err)
	require.Len(t, rep.Rows, 1)
	assert.Equal(t, "Fresh", rep.Rows[0].Agent)
}

func TestTheFileIsPrivateToItsOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not the permission model on Windows")
	}
	_, p := openT(t)
	fi, err := os.Stat(p)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
}

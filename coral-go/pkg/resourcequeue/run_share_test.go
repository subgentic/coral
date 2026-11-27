package resourcequeue

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21790: an agent holds one slot per resource, so a second `claim --run` joins the first's entry. The second run's end gave the slot back while the first run's job (on another machine, over ssh) went on: the queue
// showed the slot free while it was in use. Each run now gives back only its own share; the entry goes with the last one.
func TestTwoRunsOfOneAgentShareTheSlotAndTheFirstKeepsItWhenTheSecondEnds(t *testing.T) {
	q, _ := fixture(t, Config{})
	require.NoError(t, q.Define(Resource{Key: "epoch", Slots: 1}))
	held := func() int { st, err := q.Status("epoch"); require.NoError(t, err); return len(st.Holders) }

	res, err := q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-1"})
	require.NoError(t, err)
	require.True(t, res.Granted)
	res, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-2"})
	require.NoError(t, err)
	require.True(t, res.Granted, "the second run joins the slot it holds")
	assert.Equal(t, 1, held())

	require.NoError(t, q.ReleaseRun("epoch", "Dev", "run-2"))
	assert.Equal(t, 1, held(), "the second run ended: the first run's slot is still its")
	_, err = q.Renew("epoch", "Dev")
	require.NoError(t, err, "and it can still be renewed (no 409 for the first run)")
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "run-1"))
	assert.Equal(t, 0, held(), "the last run ended: the slot went back")
}

func TestARunEndingDoesNotEndAPlainClaimOnTheSameEntryAndAPlainReleaseStillReleases(t *testing.T) {
	q, _ := fixture(t, Config{})
	require.NoError(t, q.Define(Resource{Key: "epoch", Slots: 1}))
	held := func() int { st, _ := q.Status("epoch"); return len(st.Holders) }
	_, err := q.Claim("epoch", Claimant{Agent: "Dev"}) // by hand
	require.NoError(t, err)
	_, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-1"})
	require.NoError(t, err)
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "run-1"))
	assert.Equal(t, 1, held(), "the hand claim stands")
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "")) // no run id: the plain release, as before
	assert.Equal(t, 0, held())
	// an unknown run id releases, as Release does
	_, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-9"})
	require.NoError(t, err)
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "other"))
	assert.Equal(t, 0, held())
}

// #21797: one agent sending many different run ids cannot grow its own entry without bound: past the cap an extra run folds into the plain claim.
func TestAnAgentsEntryRemembersAtMostMaxRunsRunIds(t *testing.T) {
	q, _ := fixture(t, Config{})
	require.NoError(t, q.Define(Resource{Key: "epoch", Slots: 1}))
	for i := 0; i < MaxRunsPerEntry+20; i++ {
		res, err := q.Claim("epoch", Claimant{Agent: "Dev", RunID: fmt.Sprintf("run-%d", i)})
		require.NoError(t, err)
		require.True(t, res.Granted)
	}
	e := q.entryFor("epoch", "Dev")
	require.NotNil(t, e)
	assert.Len(t, e.Runs, MaxRunsPerEntry)
	assert.True(t, e.Base, "the extras stand on the plain claim, which a run ending does not end")
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "run-0"))
	st, _ := q.Status("epoch")
	assert.Len(t, st.Holders, 1, "the slot is still held")
}

// #21800: a `claim --run` killed with SIGKILL never ends its run. The server drops a run whose process is gone: the other run's end then frees the slot at once, and an entry with only dead runs goes on the next Reap.
func TestARunWhoseProcessIsGoneIsDroppedOnReap(t *testing.T) {
	dead := map[int]bool{}
	q, _ := fixture(t, Config{PidAlive: func(pid int) bool { return !dead[pid] }})
	require.NoError(t, q.Define(Resource{Key: "epoch", Slots: 1}))
	held := func() int { st, _ := q.Status("epoch"); return len(st.Holders) }
	_, err := q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-1", RunPID: 111})
	require.NoError(t, err)
	_, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-2", RunPID: 222})
	require.NoError(t, err)

	_, err = q.Reap()
	require.NoError(t, err)
	assert.Equal(t, 1, held(), "both runs alive: held")

	dead[222] = true // run-2 killed: it never gives its share back
	_, err = q.Reap()
	require.NoError(t, err)
	assert.Equal(t, 1, held(), "run-1 still runs")
	require.NoError(t, q.ReleaseRun("epoch", "Dev", "run-1"))
	assert.Equal(t, 0, held(), "run-1's end frees the slot at once: the dead run-2 no longer holds it")

	_, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-3", RunPID: 333})
	require.NoError(t, err)
	dead[333] = true
	ended, err := q.Reap()
	require.NoError(t, err)
	assert.Len(t, ended, 1, "an entry with only dead runs is ended")
	assert.Equal(t, 0, held())
}

func TestAPlainClaimOnTheEntryKeepsItWhenItsRunDies(t *testing.T) {
	q, _ := fixture(t, Config{PidAlive: func(int) bool { return false }})
	require.NoError(t, q.Define(Resource{Key: "epoch", Slots: 1}))
	_, err := q.Claim("epoch", Claimant{Agent: "Dev"})
	require.NoError(t, err)
	_, err = q.Claim("epoch", Claimant{Agent: "Dev", RunID: "run-1", RunPID: 111})
	require.NoError(t, err)
	_, err = q.Reap()
	require.NoError(t, err)
	st, _ := q.Status("epoch")
	assert.Len(t, st.Holders, 1)
}

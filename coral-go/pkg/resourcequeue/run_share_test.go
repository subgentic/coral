package resourcequeue

import (
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

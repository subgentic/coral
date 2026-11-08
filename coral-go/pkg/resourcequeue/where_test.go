package resourcequeue

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14354: a resource says where a run through it happens: here, remote, or nothing. Only those three; it is kept through a restart; a definition saved before the field existed loads as "nothing", which
// heavy run refuses rather than guesses.
func TestAResourceSaysHereRemoteOrNothingAndNothingElse(t *testing.T) {
	q, _ := fixture(t, Config{})
	for _, where := range []string{"", WhereHere, WhereRemote} {
		require.NoError(t, q.Define(Resource{Key: "box", Slots: 1, Where: where}), "%q", where)
		st, err := q.Status("box")
		require.NoError(t, err)
		assert.Equal(t, where, st.Resource.Where)
	}
	for _, where := range []string{"Here", "elsewhere", "remote ", "mini"} {
		assert.ErrorIs(t, q.Define(Resource{Key: "box", Slots: 1, Where: where}), ErrBadResource, "%q", where)
	}
	st, _ := q.Status("box")
	assert.Equal(t, WhereRemote, st.Resource.Where, "a refused definition changes nothing")
}

func TestWhereSurvivesARestartAndAnOldDefinitionHasNone(t *testing.T) {
	p := &memPersist{}
	q, _ := fixture(t, Config{Persist: p})
	require.NoError(t, q.Define(Resource{Key: "far", Slots: 1, Machine: "far", Where: WhereRemote}))
	require.NoError(t, q.Define(Resource{Key: "near", Slots: 1, Machine: "near", Where: WhereHere}))
	q2, err := New(Config{Persist: p, Now: func() time.Time { return time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC) }})
	require.NoError(t, err)
	far, _ := q2.Status("far")
	near, _ := q2.Status("near")
	assert.Equal(t, WhereRemote, far.Resource.Where)
	assert.Equal(t, WhereHere, near.Resource.Where)

	// the saved state of a Coral from before the field: no Where in the JSON at all
	var old State
	require.NoError(t, json.Unmarshal([]byte(`{"Resources":[{"Key":"mac-heavy","Slots":2,"Machine":"mac"}],"Entries":null,"NextID":1}`), &old))
	q3, err := New(Config{Persist: &memPersist{st: old}})
	require.NoError(t, err)
	st, err := q3.Status("mac-heavy")
	require.NoError(t, err)
	assert.Equal(t, "", st.Resource.Where, "an old definition says nothing")
}

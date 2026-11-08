package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14549 (coral-hub #190956): the answer says what holds a lock, so the drawer can say a lock covers a whole board ("Comments are locked on every file of board X") and not only this file. The scope is in the
// answer only while the artifact is locked; an artifact lock wins over a board lock; a lock of another board is not this one's.
func TestTheCommentsAnswerSaysWhatHoldsTheLock(t *testing.T) {
	rig := newCmtRig(t)
	read := func(query string) map[string]any {
		code, out := rig.do("GET", cp(cmtDoc)+query, cmtAsOwner, nil)
		require.Equal(t, 200, code, fmt.Sprint(out))
		return out
	}
	out := read("?board=team-a")
	assert.Equal(t, false, out["locked"])
	assert.NotContains(t, out, "lock_scope", "no lock, no scope")

	code, o := rig.do("PUT", cp(cmtDoc)+"/lock", cmtAsOwner, map[string]any{"scope": "board", "board": "team-a"})
	require.Equal(t, http.StatusOK, code, fmt.Sprint(o))
	out = read("?board=team-a")
	assert.Equal(t, true, out["locked"])
	assert.Equal(t, "board", out["lock_scope"], "a board lock says so")
	assert.Equal(t, "team-a", out["lock_board"])
	out = read("?board=team-b")
	assert.Equal(t, false, out["locked"], "another board's lock is not this board's")
	assert.NotContains(t, out, "lock_scope")

	code, o = rig.do("PUT", cp(cmtDoc)+"/lock", cmtAsOwner, map[string]any{"scope": "artifact"})
	require.Equal(t, http.StatusOK, code, fmt.Sprint(o))
	out = read("?board=team-a")
	assert.Equal(t, "artifact", out["lock_scope"], "the file's own lock wins over the board's")
	assert.NotContains(t, out, "lock_board")
	out = read("")
	assert.Equal(t, "artifact", out["lock_scope"])
}

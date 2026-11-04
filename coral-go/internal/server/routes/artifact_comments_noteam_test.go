package routes

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator comments on a file a no-team agent sent for review (#13532): the comment names the reserved board key, which is accepted for the comment, its list and its replies; another key that starts with a
// tilde is still refused as a bad board.
func TestTheOperatorCanCommentOnAFileOnTheReservedNoTeamBoard(t *testing.T) {
	rig := newCmtRig(t)
	code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "Looks right, one question.", "anchor": anchorOf("the lock"), "board": noTeamBoardID})
	require.Equal(t, 201, code, fmt.Sprint(out))
	id := int64(out["id"].(float64))
	assert.Equal(t, noTeamBoardID, out["board"])

	code, rep := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "Thanks.", "parent_id": id, "board": noTeamBoardID})
	assert.Equal(t, 201, code, fmt.Sprint(rep))
	code, list := rig.do("GET", cp(cmtDoc)+"?board=%7Eno-team", cmtAsOwner, nil)
	require.Equal(t, 200, code, fmt.Sprint(list))
	assert.Len(t, list["comments"], 2, "the thread is read on its board")

	code, _ = rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "x", "anchor": anchorOf("the lock"), "board": "~other"})
	assert.Equal(t, 400, code, "no other tilde key is a board")
}

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

// An agent cannot write on the reserved no-team board, and cannot read what the Operator wrote there (#13539, Security's INFO 6): an agent's POST is refused as it is on every board, its reply route is refused, and
// its list of the comments leaves out a thread of a board it is not on (the reserved key has no subscriber).
func TestAnAgentCannotCommentOnOrReadTheReservedNoTeamBoard(t *testing.T) {
	rig := newCmtRig(t)
	code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "Operator's private note.", "anchor": anchorOf("the lock"), "board": noTeamBoardID})
	require.Equal(t, 201, code, fmt.Sprint(out))
	id := int64(out["id"].(float64))
	rig.uploadedBySession("s1", "") // the agent uploaded the file (it is a no-team agent), so its read is allowed at all

	code, _ = rig.do("POST", cp(cmtDoc), cmtAsAgent, map[string]any{"body": "I write here too.", "anchor": anchorOf("the lock"), "board": noTeamBoardID})
	assert.Equal(t, 403, code, "an agent cannot create a comment on the reserved board")
	code, _ = rig.do("POST", fmt.Sprintf("%s/%d/reply", cp(cmtDoc), id), cmtAsAgent, map[string]any{"body": "A reply."})
	assert.GreaterOrEqual(t, code, 400, "an agent's reply into a thread of the reserved board is refused")
	assert.Less(t, code, 500)

	code, list := rig.do("GET", cp(cmtDoc), cmtAsAgent, nil)
	require.Equal(t, 200, code, fmt.Sprint(list))
	assert.Empty(t, list["comments"], "an agent does not see a thread of the reserved board: it is on no board")
}

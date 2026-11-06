package routes

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	naming "github.com/subgentic/coral/internal/naming"
)

// #13947, the Orchestrator's decision: what the Operator posts to an agent ends the waits that match it, on every post the Operator makes, not on the board message route alone. An agent waiting on the Operator's comment is
// the common case.
func waitActive(t *testing.T, bs *board.Store, project, who string) bool {
	t.Helper()
	waits, err := bs.ListActiveWaits(context.Background(), project)
	require.NoError(t, err)
	for _, w := range waits {
		if w.SubscriberID == who {
			return true
		}
	}
	return false
}

func TestEveryPostTheOperatorMakesToAnAgentEndsTheWaitsThatMatchIt(t *testing.T) {
	dev := naming.SubscriberID("Dev", "claude")
	for name, fire := range map[string]func(t *testing.T, rig *cmtRig){
		"Send to agent on a comment": func(t *testing.T, rig *cmtRig) {
			cid := rig.ownerComment("Try 5,000 rows per batch.")
			code, out := rig.send(cid, "Dev")
			require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
		},
		"a comment on a file for review": func(t *testing.T, rig *cmtRig) {
			rig.uploadedBy(1, "team-a")
			rig.tag("for review")
			code, out := rig.commentAs(cmtAsOwner, nil)
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
		},
		"a comment on a goal": func(t *testing.T, rig *cmtRig) {
			path, _ := rig.goal("Dev")
			code, out := rig.do("POST", path, cmtAsOwner, goalComment(nil))
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
		},
		"a comment on an agent's diff": func(t *testing.T, rig *cmtRig) {
			sid := rig.diffRig(1, "Dev", "pkg/a.go")
			key := diffSubject("team-a", sid, "pkg/a.go")
			code, out := rig.do("POST", cp(key), cmtAsOwner, map[string]any{"body": "Why not wrap this error?", "anchor": diffAnchor("pkg/a.go", nil)})
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
		},
		"a saved edit sent to agents": func(t *testing.T, rig *cmtRig) {
			rig.edited()
			code, out := rig.editSend(editAsPage, "Dev")
			require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
		},
	} {
		for kind, target := range map[string]string{"a plain wait": "", "a wait from the Operator": "Operator"} {
			rig := newCmtRig(t)
			rig.agent(1, "Dev", false)
			bh := NewBoardHandler(rig.h.bs)
			rig.h.boardHandler = bh
			_, err := rig.h.bs.RegisterWait(context.Background(), "team-a", dev, "", "message", target, "waiting for the Operator", time.Hour)
			require.NoError(t, err)
			require.True(t, waitActive(t, rig.h.bs, "team-a", dev), name)
			fire(t, rig)
			bh.WaitBackground()
			assert.False(t, waitActive(t, rig.h.bs, "team-a", dev), name+", "+kind+": the agent's wait ended")
		}
	}
}

// A proposal the Operator approves or rejects is the Operator's decision: a wait --from Operator matches it though the notice is shown as Coral's.
func TestAProposalDecisionEndsAWaitFromTheOperator(t *testing.T) {
	for _, decision := range []string{"approve", "reject"} {
		e := newProposalEnv(t)
		e.settings(t, board.BoardSettingsUpdate{GoalsNeedApproval: boolp(true)})
		code, out := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta " + decision, "outcome": "People use it", "subscriber_id": "Orchestrator"})
		require.Equal(t, http.StatusAccepted, code, out)
		id := int64(out["proposal_id"].(float64))
		_, err := e.h.bs.RegisterWait(context.Background(), "team", "Orchestrator", "", "message", "Operator", "waiting for the Operator's decision", time.Hour)
		require.NoError(t, err)
		require.True(t, waitActive(t, e.h.bs, "team", "Orchestrator"))
		code, out = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(id)+"/"+decision, nil)
		require.Equal(t, http.StatusOK, code, out)
		e.h.WaitBackground()
		assert.False(t, waitActive(t, e.h.bs, "team", "Orchestrator"), decision+": the wait from the Operator ended")
	}
}

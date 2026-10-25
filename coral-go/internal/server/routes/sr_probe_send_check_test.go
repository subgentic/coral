package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's probe for #7382 (point 3: the goal request send no longer goes through the goal write's check): a differential oracle. The same request goes through the old check (goalActor, the goal write's) and the new one
// (goalRequestSender) over a grid of callers, claims and enforcement; the answer (allowed or not, the actor it names, the status of a refusal) must be the same in every cell. Only the words of a refusal may differ.
func TestSendCheckAnswersAsTheGoalWriteCheckDidInEveryCell(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "alpha", "Orchestrator A", "Orchestrator", "claude-orch-a", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "alpha", "Dev A", "Developer", "claude-dev-a", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "beta", "Orchestrator B", "Orchestrator", "claude-orch-b", nil, "all")
	require.NoError(t, err)
	t.Cleanup(func() { setIdentityActorEnforced(false) })

	callers := map[string]*Actor{
		"no identity layer (a claim)": nil,
		"the Operator (cookie, key)":  {Kind: ActorOperator, Name: "Operator"},
		"Coral Hub as the operator":   {Kind: ActorHub, Name: "Operator", HubUser: "hub-user-1234abcd"},
		"a Hub user":                  {Kind: ActorHub, Name: "hub-user-1234abcd"},
		"orchestrator's token":        {Kind: ActorToken, Name: "Orchestrator A"},
		"a worker's token":            {Kind: ActorToken, Name: "Dev A"},
		"another team's orchestrator": {Kind: ActorToken, Name: "Orchestrator B"},
		"a joining token (no name)":   {Kind: ActorToken, Name: ""},
	}
	claims := []string{"Orchestrator A", "Dev A", "Orchestrator B", "Nobody", "Operator", "operator", "  Orchestrator A  ", "orchestrator a", "", "   "}
	cells, allowed := 0, 0
	for _, enforced := range []bool{false, true} {
		setIdentityActorEnforced(enforced)
		for cname, actor := range callers {
			for _, claim := range claims {
				run := func(f func(http.ResponseWriter, *http.Request, string, string) (string, bool)) (bool, string, int) {
					r := httptest.NewRequest(http.MethodPost, "/api/board/beta/goal-requests", nil)
					if actor != nil {
						r = withActor(r, *actor)
					}
					w := httptest.NewRecorder()
					got, ok := f(w, r, "alpha", claim)
					code := w.Code
					if ok {
						code = 0
					}
					return ok, got, code
				}
				oldOK, oldActor, oldCode := run(h.goalActor)
				newOK, newActor, newCode := run(h.goalRequestSender)
				cells++
				if oldOK {
					allowed++
				}
				assert.Equal(t, []any{oldOK, oldActor, oldCode}, []any{newOK, newActor, newCode}, "enforced=%v caller=%q claim=%q", enforced, cname, claim)
			}
		}
	}
	t.Logf("%d cells, %d of them allowed by the old check", cells, allowed)
	require.Greater(t, allowed, 0, "the grid has allowed cells, so a check that refuses everything cannot pass it")
	require.Less(t, allowed, cells, "and refused ones")
}

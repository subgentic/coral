package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The check that says who may plan a board's goals and send its goal requests (the goal write and the request send share it, #7389), pinned cell by cell: every caller the identity layer can produce
// against every claim, under log-only and enforced identity. Each cell is whether the check allowed it, the actor it named and the status of a refusal; the words of a refusal are pinned by their own
// tests. The expected cells are the table in testdata/planner_check_grid.txt, made with the check as it stood before it was shared (UPDATE_GOLDEN=1 rewrites it; read the diff).
func TestPlannerCheckGridIsPinned(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, sub := range [][4]string{
		{"alpha", "Orchestrator A", "Orchestrator", "claude-orch-a"}, {"alpha", "Dev A", "Developer", "claude-dev-a"}, {"beta", "Orchestrator B", "Orchestrator", "claude-orch-b"},
	} {
		_, err := h.bs.Subscribe(ctx, sub[0], sub[1], sub[2], sub[3], nil, "all")
		require.NoError(t, err)
	}
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
	checks := map[string]func(http.ResponseWriter, *http.Request, string, string) (string, bool){"goal write": h.goalActor, "request send": h.goalRequestSender}

	var lines []string
	for name, check := range checks {
		for _, enforced := range []bool{false, true} {
			setIdentityActorEnforced(enforced)
			for cname, actor := range callers {
				for _, claim := range claims {
					r := httptest.NewRequest(http.MethodPost, "/api/board/beta/goal-requests", nil)
					if actor != nil {
						r = withActor(r, *actor)
					}
					w := httptest.NewRecorder()
					got, ok := check(w, r, "alpha", claim)
					code := w.Code
					if ok {
						code = 0
					}
					lines = append(lines, fmt.Sprintf("%s | enforced=%v | %s | claim=%q | allowed=%v actor=%q status=%d", name, enforced, cname, claim, ok, got, code))
				}
			}
		}
	}
	sort.Strings(lines)
	got := strings.Join(lines, "\n") + "\n"
	allowed := strings.Count(got, "allowed=true")
	require.Greater(t, allowed, 0, "the grid has allowed cells, so a check that refuses everything cannot pass it")
	require.Less(t, allowed, len(lines), "and refused ones")
	const path = "testdata/planner_check_grid.txt"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		require.NoError(t, os.WriteFile(path, []byte(got), 0o644))
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "no pinned grid: run with UPDATE_GOLDEN=1")
	assert.Equal(t, strings.ReplaceAll(string(want), "\r\n", "\n"), got, "a cell of who may plan or send changed: read it, then regenerate (UPDATE_GOLDEN=1)")
}

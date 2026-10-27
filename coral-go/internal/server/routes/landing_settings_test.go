package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// The landing alert's settings are checked as they are saved (#8942): a bad branch, wait or nudge is refused with a message, and nothing of the body is applied.
func TestLandingSettingsAreCheckedOnSave(t *testing.T) {
	e := newAttachEnv(t, false)
	ctx := context.Background()
	save := func(l board.HealthLanding) (int, map[string]any) {
		hs := e.h.bs.GetHealthSettings(ctx, "beta")
		hs.Landing = l
		return e.put("/api/board/beta/settings", opHdr, map[string]any{"subscriber_id": "Operator", "health": hs})
	}
	for name, c := range map[string]struct {
		in   board.HealthLanding
		want string
	}{
		"a branch with a space":     {board.HealthLanding{On: true, Branch: "main now", WaitMin: 120}, "landing.branch"},
		"a branch with a dash lead": {board.HealthLanding{On: true, Branch: "--all", WaitMin: 120}, "landing.branch"},
		"a branch with dots":        {board.HealthLanding{On: true, Branch: "a..b", WaitMin: 120}, "landing.branch"},
		"a wait that is too short":  {board.HealthLanding{On: true, Branch: "main", WaitMin: 5}, "landing.wait_min"},
		"a wait that is too long":   {board.HealthLanding{On: true, Branch: "main", WaitMin: 99999}, "landing.wait_min"},
		"a negative wait":           {board.HealthLanding{On: true, Branch: "main", WaitMin: -1}, "landing.wait_min"},
		"a nudge who is no member":  {board.HealthLanding{On: true, Branch: "main", WaitMin: 120, Nudge: "Nobody"}, "landing.nudge"},
	} {
		code, out := save(c.in)
		assert.Equal(t, http.StatusBadRequest, code, name)
		assert.Contains(t, strings.ToLower(asString(out["error"])), c.want, name)
	}
	assert.False(t, e.h.bs.GetHealthSettings(ctx, "beta").Landing.On, "nothing was applied")

	code, out := save(board.HealthLanding{On: true, Branch: "release/2.0", WaitMin: 180, Nudge: "Orchestrator"})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, board.HealthLanding{On: true, Branch: "release/2.0", WaitMin: 180, Nudge: "Orchestrator"}, e.h.bs.GetHealthSettings(ctx, "beta").Landing)
}

func TestLandingSettingDefaultsWhenABodyDoesNotCarryIt(t *testing.T) {
	l := board.HealthSettings{}.Clamp().Landing
	assert.Equal(t, board.HealthLanding{Branch: "main", WaitMin: 120}, l)
	assert.Equal(t, 15, board.HealthSettings{Landing: board.HealthLanding{WaitMin: 3}}.Clamp().Landing.WaitMin)
	assert.Equal(t, "main", board.HealthSettings{Landing: board.HealthLanding{Branch: "-x"}}.Clamp().Landing.Branch)
}

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

// The goals-ready and unowned-tasks checks' settings are checked as they are saved (#8975): a wait out of range or a nudge who is no member is refused with a message, and nothing of the body is applied.
func TestWaitChecksSettingsAreCheckedOnSave(t *testing.T) {
	e := newAttachEnv(t, false)
	ctx := context.Background()
	save := func(mod func(*board.HealthSettings)) (int, map[string]any) {
		hs := e.h.bs.GetHealthSettings(ctx, "beta")
		mod(&hs)
		return e.put("/api/board/beta/settings", opHdr, map[string]any{"subscriber_id": "Operator", "health": hs})
	}
	for name, c := range map[string]struct {
		mod  func(*board.HealthSettings)
		want string
	}{
		"goals ready, a wait that is too short": {func(hs *board.HealthSettings) { hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 4} }, "goals_ready.wait_min"},
		"goals ready, a wait that is too long":  {func(hs *board.HealthSettings) { hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 10081} }, "goals_ready.wait_min"},
		"goals ready, a negative wait":          {func(hs *board.HealthSettings) { hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: -1} }, "goals_ready.wait_min"},
		"goals ready, a nudge who is no member": {func(hs *board.HealthSettings) {
			hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 30, Nudge: "Nobody"}
		}, "goals_ready.nudge"},
		"unowned, a wait that is too short": {func(hs *board.HealthSettings) { hs.UnownedTasks = board.HealthWaitCheck{On: true, WaitMin: 1} }, "unowned_tasks.wait_min"},
		"unowned, a wait that is too long":  {func(hs *board.HealthSettings) { hs.UnownedTasks = board.HealthWaitCheck{On: true, WaitMin: 99999} }, "unowned_tasks.wait_min"},
		"unowned, a nudge who is no member": {func(hs *board.HealthSettings) {
			hs.UnownedTasks = board.HealthWaitCheck{On: true, WaitMin: 15, Nudge: "Nobody"}
		}, "unowned_tasks.nudge"},
	} {
		code, out := save(c.mod)
		assert.Equal(t, http.StatusBadRequest, code, name)
		assert.Contains(t, strings.ToLower(asString(out["error"])), c.want, name)
	}
	after := e.h.bs.GetHealthSettings(ctx, "beta")
	assert.Equal(t, board.HealthWaitCheck{On: true, WaitMin: 30}, after.GoalsReady, "nothing was applied: the defaults (on, 30 minutes)")
	assert.Equal(t, board.HealthWaitCheck{On: true, WaitMin: 15}, after.UnownedTasks, "nothing was applied: the defaults (on, 15 minutes)")

	code, out := save(func(hs *board.HealthSettings) {
		hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 45, Nudge: "Orchestrator"}
		hs.UnownedTasks = board.HealthWaitCheck{On: false, WaitMin: 20} // the operator can switch a check off
	})
	require.Equal(t, http.StatusOK, code, out)
	saved := e.h.bs.GetHealthSettings(ctx, "beta")
	assert.Equal(t, board.HealthWaitCheck{On: true, WaitMin: 45, Nudge: "Orchestrator"}, saved.GoalsReady)
	assert.Equal(t, board.HealthWaitCheck{On: false, WaitMin: 20}, saved.UnownedTasks)
}

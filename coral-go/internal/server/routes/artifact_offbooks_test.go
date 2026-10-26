package routes

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// An upload by an agent with no task in progress is work done off the books (#7793): it is noted for the orchestrator's check when the team's check and its upload switch are on.
func (l *linkRig) offBooks() []board.OffBooks {
	l.t.Helper()
	got, err := l.h.bs.PendingOffBooks(context.Background(), "alpha", time.Now(), map[string]bool{board.OffBooksUpload: true})
	require.NoError(l.t, err)
	return got
}

func TestAnUploadWithNoTaskInProgressIsNotedForTheHealthCheck(t *testing.T) {
	l := newLinkRig(t)
	ctx := context.Background()
	require.NoError(t, l.h.bs.SetHealthOn(ctx, "alpha", true))
	_, err := l.h.bs.Subscribe(ctx, "alpha", "Frontend", "Orchestrator", "agent-s2", nil, "all") // Frontend is the team's orchestrator
	require.NoError(t, err)

	// fires: nothing in progress
	code, out := l.post("s1", "off the books", nil)
	require.Equal(t, http.StatusCreated, code, out)
	got := l.offBooks()
	require.Len(t, got, 1)
	assert.Equal(t, board.OffBooksUpload, got[0].Kind)
	assert.Equal(t, "Backend", got[0].Agent)
	assert.Equal(t, "uploaded an artifact ("+out["digest"].(string)[7:15]+") with no task in progress", got[0].Detail, "a fixed phrase and the short digest: never the artifact's name or text")

	// the same bytes again are the same occurrence
	code, _ = l.post("s1", "off the books", nil)
	require.Equal(t, http.StatusCreated, code)
	assert.Len(t, l.offBooks(), 1)

	// does not fire with --no-task (the agent said so), for the orchestrator, or while a task is in progress
	code, _ = l.post("s1", "said none", map[string]string{taskHeader: "none"})
	require.Equal(t, http.StatusCreated, code)
	code, _ = l.post("s2", "the orchestrator's", nil)
	require.Equal(t, http.StatusCreated, code)
	l.task("alpha", "Backend", true)
	code, _ = l.post("s1", "on a task", nil)
	require.Equal(t, http.StatusCreated, code)
	assert.Len(t, l.offBooks(), 1, "no new occurrence")
}

func TestAnUploadIsNotNotedWhenTheSwitchOrTheCheckIsOff(t *testing.T) {
	l := newLinkRig(t)
	ctx := context.Background()
	code, _ := l.post("s1", "check off", nil)
	require.Equal(t, http.StatusCreated, code)
	assert.Empty(t, l.offBooks(), "the team's check is off by default: nothing is kept for it")

	require.NoError(t, l.h.bs.SetHealthOn(ctx, "alpha", true))
	hs := l.h.bs.GetHealthSettings(ctx, "alpha")
	hs.UploadNoTask.On = false
	require.NoError(t, l.h.bs.SetHealthSettings(ctx, "alpha", hs))
	code, _ = l.post("s1", "switch off", nil)
	require.Equal(t, http.StatusCreated, code)
	assert.Empty(t, l.offBooks(), "the upload switch is off: silent")

	hs.UploadNoTask.On = true
	require.NoError(t, l.h.bs.SetHealthSettings(ctx, "alpha", hs))
	code, _ = l.post("s1", "switch on", nil)
	require.Equal(t, http.StatusCreated, code)
	assert.Len(t, l.offBooks(), 1)
}

func TestAnUploadOfAMemberWithTwoTasksInProgressIsNotOffTheBooks(t *testing.T) {
	l := newLinkRig(t)
	ctx := context.Background()
	require.NoError(t, l.h.bs.SetHealthOn(ctx, "alpha", true))
	l.task("alpha", "Backend", true)
	b := l.task("alpha", "Backend", false)
	db, err := sqlx.Open("sqlite", l.boardDB)
	require.NoError(t, err)
	defer db.Close()
	_, err = db.Exec(`UPDATE board_tasks SET status = 'in_progress' WHERE id = ?`, b) // a store that should not exist: the upload links none, but the member has work
	require.NoError(t, err)
	code, out := l.post("s1", "two tasks", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id")
	assert.Empty(t, l.offBooks(), "linked to none, but not off the books")
}

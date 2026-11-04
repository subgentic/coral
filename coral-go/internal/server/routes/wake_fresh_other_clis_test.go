package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/linktest"
	"github.com/subgentic/coral/internal/store"
)

// #12778: a wake of Pi, Antigravity or OpenCode with nothing to resume starts the agent fresh (with its role), as Claude does (#12714), instead of passing a resume
// the CLI cannot use.

func registerWakeAgent(t *testing.T, r *sleepRig, agentType string) *store.LiveSession {
	t.Helper()
	require.NoError(t, r.ss.SetSetting(r.ctx, "cli_path_"+agentType, stubCLI(t)))
	sid := uuid.NewString()
	team := "autosleep"
	require.NoError(t, r.ss.RegisterLiveSession(r.ctx, &store.LiveSession{SessionID: sid, AgentName: agentType, AgentType: agentType, BoardName: &team, WorkingDir: t.TempDir()}))
	ls, err := r.ss.GetLiveSession(r.ctx, sid)
	require.NoError(t, err)
	return ls
}

func TestPiWakeWithNoSavedSessionStartsFresh(t *testing.T) {
	r := newSleepRig(t)
	ls := registerWakeAgent(t, r, "pi")
	plan, err := r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.Empty(t, plan.params.ResumeSessionID)
	assert.True(t, plan.freshStart)
	assert.False(t, plan.params.NoStartPrompt, "a fresh start keeps its role message even on an auto-wake")

	dir := filepath.Join(r.h.cfg.CoralDir(), "pi-sessions", ls.SessionID)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, plan.freshStart, "an empty session folder is still nothing to continue")

	// only a regular .jsonl file is a saved session: a link named *.jsonl (it could point anywhere) and a regular file of another name are not
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o600))
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, plan.freshStart, "a non-.jsonl file is no saved session")
	// the link case alone skips where this account can't make a link (CI still runs it), so the rest of the test runs everywhere
	t.Run("a link named .jsonl", func(t *testing.T) {
		linktest.Symlink(t, filepath.Join(dir, "notes.txt"), filepath.Join(dir, "link.jsonl"))
		plan, err := r.h.prepareWake(r.ctx, ls, true)
		require.NoError(t, err)
		assert.True(t, plan.freshStart, "a symlink named .jsonl is no saved session")
	})

	require.NoError(t, os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte("{}\n"), 0o600))
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.False(t, plan.freshStart)
	assert.Equal(t, ls.SessionID, plan.params.ResumeSessionID)
	assert.True(t, plan.params.NoStartPrompt)
}

func TestAntigravityWakeResumesOnlyTheBoundConversation(t *testing.T) {
	r := newSleepRig(t)
	base := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", filepath.Join(base, "brain"))
	require.NoError(t, os.MkdirAll(filepath.Join(base, "brain"), 0o700))
	ls := registerWakeAgent(t, r, "agy")

	plan, err := r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, plan.freshStart, "no bound conversation: fresh, not Coral's own id that agy does not know")
	assert.Empty(t, plan.params.ResumeSessionID)
	assert.False(t, plan.params.NoStartPrompt)

	conv := uuid.NewString()
	links := filepath.Join(base, "coral-session-links")
	require.NoError(t, os.MkdirAll(links, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(links, ls.SessionID+".json"), []byte(`{"conversation_id":"`+conv+`"}`), 0o600))
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, plan.freshStart, "a link whose transcript is gone is nothing to resume")

	tr := filepath.Join(base, "brain", conv, ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(tr, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(tr, "transcript.jsonl"), []byte("{}\n"), 0o600))
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.False(t, plan.freshStart)
	assert.Equal(t, conv, plan.params.ResumeSessionID, "agy is given its own conversation id")
	assert.True(t, plan.params.NoStartPrompt)
}

func TestOpencodeWakeWithNoStoredSessionStartsFresh(t *testing.T) {
	r := newSleepRig(t)
	fo := &fakeOpencode{stored: map[string]string{}}
	r.h.opencode = fo
	ls := registerWakeAgent(t, r, "opencode")

	plan, err := r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, plan.freshStart)
	assert.Empty(t, plan.params.ResumeSessionID)
	assert.False(t, plan.params.NoStartPrompt)

	fo.stored[ls.SessionID] = "ses_abc123"
	plan, err = r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.False(t, plan.freshStart)
	assert.True(t, plan.params.NoStartPrompt)
}

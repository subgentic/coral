package routes

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #17324 (#17318): a person's Wake of a resumed conversation types a short note, not the original starting prompt, which an agent that remembers an old plan took as a reason to restart it.
func TestAWakeOfAResumedConversationTypesAWakeNoteNotTheOriginalPrompt(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	// a test must not depend on an agent CLI being installed (epoch has no hermes, #17906): every type resolves to a stub
	stubCLIPaths(t, ss)
	require.NoError(t, ss.SetSetting(ctx, "cli_path_hermes", stubCLI(t)))
	const id = "00000000-0000-0000-0000-000000017324"
	team := "team-a"
	original := "ORIGINAL-START-PROMPT: run the plan from step 1"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "repo", WorkingDir: t.TempDir(), BoardName: &team, Prompt: &original}))
	ls, err := ss.GetLiveSession(ctx, id)
	require.NoError(t, err)

	plan, err := h.prepareWake(ctx, ls, false)
	require.NoError(t, err)
	require.NotEmpty(t, plan.params.ResumeSessionID, "the conversation is resumed")
	assert.NotContains(t, plan.params.Prompt, "ORIGINAL-START-PROMPT", "the original starting prompt is not typed again")
	for _, want := range []string{"asleep", "awake", "coral-board read", "coral-board task list", "--ask"} {
		assert.Contains(t, plan.params.Prompt, want, "the wake note says %q", want)
	}
	assert.NotContains(t, plan.params.Prompt, "handled", "it does not tell the agent that messages are handled: some came while it slept")
	assert.Less(t, len(plan.params.Prompt), 700, "it is a short note")

	// an auto-wake by a delivery types nothing, as before (#12358)
	auto, err := h.prepareWake(ctx, ls, true)
	require.NoError(t, err)
	assert.True(t, auto.params.NoStartPrompt)

	// a conversation that is not resumed starts new, with its original prompt
	fresh := *ls
	fresh.AgentType = "hermes" // no Hermes session of its own: nothing to resume
	plan2, err := h.prepareWake(ctx, &fresh, false)
	require.NoError(t, err)
	if plan2.params.ResumeSessionID == "" {
		assert.True(t, strings.Contains(plan2.params.Prompt, "ORIGINAL-START-PROMPT"), "a new conversation gets the original prompt")
	}
}

package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #21603: a Resume with no agent_type resumes the agent's stored type. It used to start claude for a pi agent.
func TestResumeWithoutAgentTypeUsesStoredType(t *testing.T) {
	t.Parallel()
	_, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "22222222-2222-4222-8222-222222222222"
	name := naming.SessionName(at.Pi, sid)
	dir := t.TempDir()
	term.addSession(name, dir)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Pi, AgentName: "proj", WorkingDir: dir}))

	plan, fail := handler.resumeResolve(ctx, name, &resumeRequest{SessionID: "33333333-3333-4333-8333-333333333333", CurrentSessionID: sid})
	require.Nil(t, fail)
	assert.Equal(t, at.Pi, plan.agentType, "no agent_type: the stored type, not claude")

	plan, fail = handler.resumeResolve(ctx, name, &resumeRequest{SessionID: "33333333-3333-4333-8333-333333333333", CurrentSessionID: sid, AgentType: at.Pi})
	require.Nil(t, fail)
	assert.Equal(t, at.Pi, plan.agentType)

	// an unknown session still falls back to claude (the older default)
	assert.Equal(t, at.Claude, handler.storedResumeType(ctx, "nobody", ""))
}

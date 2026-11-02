package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #12425: a person's message to a Hermes agent whose CLI exited at a plain shell (it died on its first-use setup) was typed into the shell ('bash: hello: command not found') and the agent was marked Ended only at the
// reconciler's next pass. Hermes has no input box Coral recognises, so the send was the plain one. The message is now refused before anything is typed, and the failed send marks the agent Ended at once (Send does).
func TestAPersonsMessageIsNotTypedIntoTheShellAHermesLeft(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	defer server.Close()
	ctx := context.Background()
	const sid = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "h", WorkingDir: "/tmp/h"}))
	name := naming.SessionName("hermes", sid)
	mock.addSession(name, "/tmp/h")
	term := newFGTerminal(mock)
	h.terminal = term

	term.setFG(name, "bash") // Hermes exited and left its shell
	err := h.deliverHumanSend(ctx, name, "hermes", sid, "hello")
	require.ErrorIs(t, err, errSendAgentExited)
	assert.Empty(t, term.sentTo(name), "nothing was typed into the shell")
	status, out, ok := humanSendError(err)
	require.True(t, ok)
	assert.Equal(t, 409, status)
	assert.Equal(t, "agent_exited", out["code"])
	assert.Equal(t, true, out["not_sent"], "said plainly as not sent")
	assert.True(t, h.markEndedAfterFailedSend(ctx, name, "hermes", sid), "and the agent is Ended at once, not at the reconciler's pass")

	term.setFG(name, "python3") // Hermes is running
	require.NoError(t, h.deliverHumanSend(ctx, name, "hermes", sid, "hello"))
	assert.Equal(t, []string{"hello"}, term.sentTo(name), "a running Hermes gets its message")
}

// #12451: the same for OpenCode (no input box Coral recognises either): an OpenCode that exited at a plain shell gets nothing typed; a running one does; a custom agent, which may be a shell on purpose, is not refused.
func TestAPersonsMessageIsNotTypedIntoTheShellAnOpenCodeLeft(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	defer server.Close()
	ctx := context.Background()
	term := newFGTerminal(mock)
	h.terminal = term
	for _, c := range []struct {
		agentType, sid string
		refused        bool
	}{
		{"opencode", "8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a", true},
		{"custom", "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b", false},
	} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: c.sid, AgentType: c.agentType, AgentName: "o", WorkingDir: "/tmp/o"}))
		name := naming.SessionName(c.agentType, c.sid)
		mock.addSession(name, "/tmp/o")
		term.setFG(name, "zsh") // the CLI exited and left its shell
		err := h.deliverHumanSend(ctx, name, c.agentType, c.sid, "hello")
		if c.refused {
			require.ErrorIs(t, err, errSendAgentExited, c.agentType)
			assert.Empty(t, term.sentTo(name), c.agentType+": nothing was typed into the shell")
			term.setFG(name, "node") // OpenCode is running
			require.NoError(t, h.deliverHumanSend(ctx, name, c.agentType, c.sid, "hello"))
			assert.Equal(t, []string{"hello"}, term.sentTo(name), "a running OpenCode gets its message")
		} else {
			require.NoError(t, err, c.agentType)
			assert.Equal(t, []string{"hello"}, term.sentTo(name), c.agentType+" is not refused at a shell")
		}
	}
}

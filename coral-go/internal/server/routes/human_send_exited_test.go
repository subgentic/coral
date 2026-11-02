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

package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13762 (the Operator: an agent sent a comment can read it but its reply gets 403 'not invited to the thread', the agent on a remote computer of their self-hosted Hub): the whole flow as that computer sees it. The Hub
// reaches it with the computer's API KEY, and a stamp rides on the send only, so the owner's comment, the send to the agent, the agent's reply (the agent calls its OWN computer), the owner's read of the thread and a second
// comment with its own send are all key callers on the computer's side. The reply must land in the thread of the comment the agent was asked into, once per ask, and only there.
func TestARemoteComputersAgentRepliesToACommentSentThroughTheHubWithTheKey(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	key := func(method, path string, body any) (int, map[string]any) { return rig.do(method, path, cmtAsKey, body) }
	stamped := func(method, path string, body any) (int, map[string]any) { return rig.do(method, path, cmtAsStamped, body) } // the send is the one stamped route

	code, out := key("POST", cp(cmtDoc), map[string]any{"body": "Is this 1-2x slower?", "anchor": anchorOf("the lock"), "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	first := int64(out["id"].(float64))

	code, out = stamped("POST", fmt.Sprintf("%s/%d/send", cp(cmtDoc), first), map[string]any{"agents": []string{"Dev"}})
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	require.Equal(t, "sent", states(out)["Dev"], "the send through the Hub's key reaches the agent")

	code, rep := rig.reply(first, asAgentSession(1), "Yes: about 1.5x.")
	require.Equal(t, http.StatusCreated, code, "the asked agent's reply must be accepted: "+fmt.Sprint(rep))
	assert.Equal(t, "agent", rep["author"].(map[string]any)["kind"])

	code, list := key("GET", cp(cmtDoc), nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, list["comments"], 2, "the owner sees the agent's reply in the thread, through the key")

	// a second comment, sent to the OTHER agent: its own ask, its own reply; the first agent is not invited to it
	code, out = key("POST", cp(cmtDoc), map[string]any{"body": "And the second case?", "anchor": anchorOf("the lock"), "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	second := int64(out["id"].(float64))
	code, out = stamped("POST", fmt.Sprintf("%s/%d/send", cp(cmtDoc), second), map[string]any{"agents": []string{"QA"}})
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	code, rep = rig.reply(second, asAgentSession(2), "Same.")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	code, rep = rig.reply(second, asAgentSession(1), "uninvited")
	assert.Equal(t, http.StatusForbidden, code, "an agent that was not sent the second comment is still refused")
	assert.Equal(t, "not_asked", rep["code"])
}

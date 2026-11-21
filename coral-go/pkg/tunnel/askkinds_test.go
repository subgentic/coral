package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20413: the vocabulary of asks a Hub may answer is closed and pinned. A permission prompt, a custom-check approval, a device-key approval and a proposal are not in it.
func TestTheAskVocabularyIsClosedAndPinned(t *testing.T) {
	assert.Equal(t, []string{"agent_ask", "ask_button", "message_reply"}, AskKinds())
	for _, k := range []string{"permission", "check_approval", "device_key", "proposal", "", "AGENT_ASK", "agent_ask ", "local_only", "never"} {
		assert.False(t, ValidAskKind(k), "%q", k)
	}
	for _, k := range AskKinds() {
		assert.True(t, ValidAskKind(k))
	}
}

func TestTheAskRouteTableMapsEachAnsweringRouteOnce(t *testing.T) {
	for _, c := range []struct{ method, path, kind string }{
		{"POST", "/api/agent-asks/7/answer", AskKindAgentAsk},
		{"POST", "/api/agent-asks/7/dismiss", AskKindAgentAsk},
		{"POST", "/api/agent-asks/7/images", AskKindAgentAsk},
		{"POST", "/api/board/team/asks/12/buttons/3/claim", AskKindAskButton},
		{"POST", "/api/board/team/asks/12/buttons/3/settle", AskKindAskButton},
		{"POST", "/api/board/team/asks/12/close", AskKindAskButton},
		{"POST", "/api/board/team/proposals/4/approve", AskKindLocalOnly},
		{"POST", "/api/board/team/proposals/4/reject", AskKindLocalOnly},
		{"POST", "/api/board/team/artifacts/ab12/review", AskKindLocalOnly},
		{"PUT", "/api/board/team/artifacts/ab12/review", AskKindLocalOnly},
		{"DELETE", "/api/board/team/artifacts/ab12/review", AskKindLocalOnly},
		// Not answering routes: an ordinary post (the handler decides a reply), a read, a wrong method, extra or missing segments.
		{"POST", "/api/board/team/messages", ""},
		{"GET", "/api/agent-asks/7/answer", ""},
		{"POST", "/api/agent-asks/7/answer/x", ""},
		{"POST", "/api/agent-asks//answer", ""},
		{"POST", "/api/board/team/asks/12", ""},
	} {
		assert.Equal(t, c.kind, AskRouteKind(c.method, c.path), c.method+" "+c.path)
	}
	seen := map[string]bool{}
	for _, p := range AskRoutePatterns() {
		assert.False(t, seen[p], "mapped twice: "+p)
		seen[p] = true
	}
}

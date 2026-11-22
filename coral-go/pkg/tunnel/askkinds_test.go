package tunnel

import (
	"strings"
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
		{"POST", "/api/agent-asks//answer", AskKindLocalOnly}, // not canonical, under an ask prefix: fails closed
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

// Fail closed (Security's MUST 2): a spelling of an ask route the table does not know, under the ask prefixes, is local-only and never "not an ask route"; a plain path that names none of them is not touched.
func TestNonCanonicalPathsUnderTheAskPrefixesFailClosed(t *testing.T) {
	for _, p := range []string{
		"//api/agent-asks/1/dismiss", "/api/agent-asks//1/dismiss", "/api/agent-asks/1/dismiss/", "/api/agent-asks/./1/dismiss", "/api/x/../agent-asks/1/dismiss",
		"/api/agent-asks%2F1/dismiss", "/api/agent-asks/1%2Fdismiss", "/api/agent-asks/1/dismiss%2F", "/api/agent-asks/%2e%2e/agent-asks/1/dismiss", "/api/agent-asks\\1/dismiss",
		"/api/board/team/asks/1/close/", "/api/board/team//asks/1/close", "/api/board/team/asks/1/buttons/1%2Fclaim", "/api/board/team/%2e/asks/1/close", "/api/board/team/asks/%2F/close",
		"/api/board/team/proposals/1/approve/", "/api/board/team/proposals/1//approve", "/api/board/team/artifacts/ab/review/", "/api/board/team/artifacts%2Fab/review", "/api/board/team/artifacts/ab/%72eview/",
		"/api/agent-asks/1/dismiss%00", "/api/agent-asks/%zz/dismiss", "/api/AGENT-ASKS//1/dismiss",
	} {
		assert.Equal(t, AskKindLocalOnly, AskRouteKind("POST", p), p)
		assert.Equal(t, AskKindLocalOnly, AskRouteKind("GET", p), "any method: "+p)
	}
	for _, p := range []string{"/api/board/team/messages", "/api/sessions/live/x/send", "/api/board/team//messages", "/api/board/team/tasks/1/reply/", "/api/cloud/links/lnk-aaaaaaaa/cap", ""} {
		assert.Equal(t, "", AskRouteKind("POST", p), p)
	}
	// A legitimate encoded segment (a team name with a space) still maps.
	assert.Equal(t, AskKindAskButton, AskRouteKind("POST", "/api/board/My%20Team/asks/1/close"))
}

func TestEveryAskKindHasItsSettingsSentenceAndMessageReplyNamesTheLabel(t *testing.T) {
	for _, k := range AskKinds() {
		if AskKindText(k) == "" {
			t.Errorf("%s has no sentence", k)
		}
	}
	if AskKindText("nope") != "" {
		t.Error("a kind that is not in the vocabulary has no sentence")
	}
	got := AskKindText(AskKindMessageReply)
	for _, want := range []string{"hub-user", "never as the Operator", "answers nothing"} {
		if !strings.Contains(got, want) {
			t.Errorf("message_reply sentence lacks %q: %s", want, got)
		}
	}
}

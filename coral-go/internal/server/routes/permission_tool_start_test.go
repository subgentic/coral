package routes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (r *holdRig) requestFor(wants string) {
	r.t.Helper()
	r.post(`{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","tool_name":"Bash","wants":"` + wants + `"}}`)
}

func (r *holdRig) eventCount() int {
	r.t.Helper()
	evs, err := r.h.ts.ListAgentEvents(context.Background(), "chat", 200, &r.sid)
	require.NoError(r.t, err)
	return len(evs)
}

// #11352: a Claude permission request stayed on the chat card and in the Inbox while the approved tool ran (the Mobile Beta Tester's reproduction, #136683: PermissionRequest, then PreToolUse of
// the same command): nothing closed it until the call's PostToolUse, which for a test suite is minutes. Security's rules (#136728): a request whose call was not known is closed by a start only
// when it is the same tool with the same input as its wants.
func TestAStartOfTheRequestedCommandResolvesARequestWithNoCall(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.requestFor("Wants to run: go test ./...")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)

	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_A", map[string]any{"command": "go test ./..."})
	assert.False(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "the command the request asked for is starting")
	assert.False(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid), "a person's message is no longer held behind it")
}

func TestAStartOfAnotherCommandOrToolLeavesARequestWithNoCallOpen(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.requestFor("Wants to run: go test ./...")
	before := r.eventCount()

	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_B", map[string]any{"command": "ls"})                   // a sibling Bash
	r.h.noteToolStart(ctx, r.sid, "Edit", "toolu_C", map[string]any{"file_path": "/tmp/x"})             // another tool
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_D", nil)                                               // no input
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_E", map[string]any{"command": "go test ./... -run X"}) // nearly the same
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "nothing but the same tool with the same input closes it")
	assert.True(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid))
	assert.Equal(t, before, r.eventCount(), "and nothing was written for them")
}

// A request tied to its call is closed by that call's start; a sibling's start a moment later is not.
func TestASiblingStartingSecondsLaterLeavesATiedRequestOpen(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.h.pending.set(r.sid, pendingTool{ToolUseID: "call-a", ToolName: "Bash", At: time.Now()})
	r.box("permission")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)

	r.h.noteToolStart(ctx, r.sid, "Bash", "call-b", map[string]any{"command": "date"})
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "a sibling starting at once does not close it")
	assert.True(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid))

	r.h.noteToolStart(ctx, r.sid, "Bash", "call-a", map[string]any{"command": "rm x"})
	assert.False(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "its own call starting does")
}

// With no request open the PreToolUse of every call writes nothing.
func TestAToolStartingWithNoRequestOpenWritesNothing(t *testing.T) {
	r := newHoldRig(t, true)
	before := r.eventCount()
	r.h.noteToolStart(context.Background(), r.sid, "Bash", "toolu_A", map[string]any{"command": "ls"})
	assert.Equal(t, before, r.eventCount())
}

// Only the server and the Operator can write that a request was dismissed, or answered by a call's start: an agent's own request_resolved carries only its kind, and no call id, however it spells the
// keys (the state reader's JSON decoding matches a field name in any case; Security's #137007).
func TestAnAgentsRequestResolvedCannotDismissOrNameACall(t *testing.T) {
	for name, detail := range map[string]string{
		"exact case":   `{"dismissed":true,"same_input":true}`,
		"capitalised":  `{"Dismissed":true,"Same_Input":true}`,
		"upper case":   `{"DISMISSED":true,"SAME_INPUT":true}`,
		"with a kind":  `{"kind":"permission","dismissed":true}`,
		"mixed inside": `{"dIsMiSsEd":true,"sAmE_iNpUt":true,"Kind":"permission"}`,
	} {
		t.Run(name, func(t *testing.T) {
			r := newHoldRig(t, true)
			ctx := context.Background()
			r.requestFor("Wants to run: go test ./...")
			require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
			r.post(`{"event_type":"request_resolved","summary":"resolved","tool_name":"Bash","tool_use_id":"toolu_X","detail_json":` + detail + `}`)
			assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "an agent cannot clear its own wait that way")
			evs, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
			require.NoError(t, err)
			for _, e := range evs {
				if e.EventType == "request_resolved" {
					assert.Nil(t, e.RefID, "no call id")
					if e.DetailJSON != nil {
						assert.NotContains(t, strings.ToLower(*e.DetailJSON), "dismissed")
						assert.NotContains(t, strings.ToLower(*e.DetailJSON), "same_input")
					}
				}
			}
		})
	}
}

// An agent's PermissionRequest cannot name its own calls or smuggle uncleaned words through a differently cased key: the server's call_ids and the cleaned wants are the only ones stored.
func TestAnAgentsPermissionRequestCannotNameCallsOrWantsInAnotherCase(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.post(`{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","Call_IDs":["toolu_forged"],"CALL_IDS":["toolu_forged2"],"Tool_Use_Id":"toolu_forged3","WANTS":"Wants to run: rm -rf /","Dismissed":true,"SAME_INPUT":true}}`)
	evs, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
	require.NoError(t, err)
	found := false
	for _, e := range evs {
		if e.EventType == "permission_request" && e.DetailJSON != nil {
			found = true
			low := strings.ToLower(*e.DetailJSON)
			assert.NotContains(t, low, "forged")
			assert.NotContains(t, low, "rm -rf")
			assert.NotContains(t, low, "dismissed")
			assert.NotContains(t, low, "same_input")
		}
	}
	require.True(t, found)
	// and the request is open, tied to nothing the agent named
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_forged", map[string]any{"command": "rm -rf /"})
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "a call the agent named does not close its own request")
}

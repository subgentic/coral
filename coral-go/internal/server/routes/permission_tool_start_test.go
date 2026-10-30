package routes

import (
	"context"
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

// Only the server and the Operator can write that a request was dismissed, or answered by a call's start: an agent's own request_resolved carries neither, and no call id.
func TestAnAgentsRequestResolvedCannotDismissOrNameACall(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.requestFor("Wants to run: go test ./...")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	r.post(`{"event_type":"request_resolved","summary":"resolved","tool_name":"Bash","tool_use_id":"toolu_X","detail_json":{"dismissed":true,"same_input":true}}`)
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "an agent cannot clear its own wait that way")
}

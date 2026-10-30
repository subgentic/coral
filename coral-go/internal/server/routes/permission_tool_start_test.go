package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11352: a Claude permission request stayed on the chat card and in the Inbox while the approved tool ran (the Mobile Beta Tester's reproduction, #136683: PermissionRequest for call A, then
// PreToolUse for A): nothing closed it until the call's PostToolUse, which for a test suite is minutes. A PreToolUse that comes while the session has a request open says the permission was
// given, so the server records it as the request's resolution.
func TestAToolStartingWhileARequestIsOpenResolvesIt(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.box("permission")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)

	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_A")
	assert.False(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "the tool is starting: the permission was given")
	assert.False(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid), "a person's message is no longer held behind it")
}

// With no request open the PreToolUse of every call writes nothing: one event per request, not one per tool call.
func TestAToolStartingWithNoRequestOpenWritesNothing(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	before, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
	require.NoError(t, err)
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_A")
	after, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
	require.NoError(t, err)
	assert.Equal(t, len(before), len(after))
}

// A request that a later one replaced is resolved once: the marker is taken by the first start.
func TestOneStartResolvesTheRequestOnce(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.box("permission")
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_A")
	mid, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
	require.NoError(t, err)
	r.h.noteToolStart(ctx, r.sid, "Bash", "toolu_B")
	end, err := r.h.ts.ListAgentEvents(ctx, "chat", 50, &r.sid)
	require.NoError(t, err)
	assert.Equal(t, len(mid), len(end), "the second start writes nothing")
}

package background

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

// unknownShellRecon is the reconciler's runtime with an exited agent CLI whose terminal runs a shell of unknown contents (git-bash, WSL).
type unknownShellRecon struct {
	*fgReconRuntime
	other string
}

func (u unknownShellRecon) AgentUnknownShell(context.Context, string, string, string) (string, bool) {
	return u.other, true
}

// #216 (Security's guard): the reconciler does not mark an agent ended while its terminal runs a shell of unknown contents: Wake would
// then type the launch line into whatever runs in that shell. A bare prompt is still marked, as before.
func TestReconciler_AShellOfUnknownContentsIsNotMarkedEnded(t *testing.T) {
	ss, rt, r := newExitedFixture(t)
	ctx := context.Background()
	registerAwake(t, ss, "claude", testUUID)
	rt.listed = []AgentInfo{{AgentType: "claude", SessionID: testUUID}}
	rt.set(FormatSessionName("claude", testUUID), "powershell")
	r.runtime = unknownShellRecon{fgReconRuntime: rt, other: "bash"}
	for i := 0; i < 3; i++ {
		r.reconcileOnce(ctx)
	}
	assert.False(t, isSleeping(t, ss, testUUID), "not marked ended: its terminal runs bash")

	r.runtime = unknownShellRecon{fgReconRuntime: rt, other: ""}
	for i := 0; i < 3; i++ {
		r.reconcileOnce(ctx)
	}
	assert.True(t, isSleeping(t, ss, testUUID), "a bare prompt is marked ended, as before")
}

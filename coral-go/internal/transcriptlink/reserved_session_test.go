package transcriptlink

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #12309: a CLI's own id is never bound to the id that holds the person's own pictures.
func TestACLIIDIsNeverBoundToTheReservedPictureSession(t *testing.T) {
	reserved := naming.PersonPictureSessionID
	// a rollout that a bind would accept for an ordinary session (it names the session): only the reserved id refuses it
	home := codexHomeFor(t)
	guardRollout(t, home, threadA, developerMarker(reserved))
	require.Error(t, BindCodex(reserved, threadA))
	assert.Empty(t, Codex(reserved).ThreadID, "nothing is linked to the reserved id")
	guardRollout(t, home, threadB, developerMarker(guardSession))
	require.NoError(t, BindCodex(guardSession, threadB), "the same shape of rollout binds for an ordinary session")
	require.Error(t, BindAgy(reserved, "conversation-1"))
	require.Error(t, BindHermes(t.TempDir(), reserved, "local-"+hexRepeat("c3", 32)))
}

func hexRepeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

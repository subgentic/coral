package routes

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19854: Send to agent has been through Coral Hub since #11354 (owner-only, Launch tier), so no comment may still say it is never offered there: a stale "never" sent the next reader to open a route that was open.
func TestNoCommentSaysSendToAgentIsNeverThroughTheHub(t *testing.T) {
	for _, f := range []string{"artifact_comment_send.go", "../../../pkg/tunnel/routes.go", "../../../pkg/frontend/static/artifact_comment_send.js"} {
		b, err := os.ReadFile(f)
		require.NoError(t, err, f)
		s := string(b)
		for _, stale := range []string{"never through Coral Hub", "Local only: it is never offered", "sending a thread to an agent, the lock and an agent's reply are unlisted", "send (hands a thread to an agent), the lock and an agent's reply"} {
			assert.False(t, strings.Contains(s, stale), "%s still says %q", f, stale)
		}
	}
}

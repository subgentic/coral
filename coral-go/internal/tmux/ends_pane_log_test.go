package tmux

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11157: a tmux command that ends or replaces a pane is logged where it is sent; one that does not is not.
func TestACommandThatEndsAPaneIsLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	for _, c := range []string{"kill-session", "kill-pane", "respawn-pane", "kill-server", "kill-window", "respawn-window"} {
		assert.True(t, endsPane[c], c)
	}
	logEndsPane([]string{"kill-session", "-t", "claude-1234"})
	assert.Contains(t, buf.String(), "command=kill-session")
	assert.Contains(t, buf.String(), "claude-1234", "the target is named")
	logEndsPane([]string{"respawn-pane", "-t", "claude-1", "secret typed text"})
	assert.NotContains(t, buf.String(), "secret typed text", "the text after the target is never logged")
	assert.False(t, endsPane["send-keys"])
	assert.False(t, endsPane["list-panes"])
}

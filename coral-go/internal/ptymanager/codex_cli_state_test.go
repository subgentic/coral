package ptymanager

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestCodex8471CLIStateDistinguishesReviewFromHumanWait(t *testing.T) {
	// Actual 0.163.0 state fragments, isolated on-request captures: automatic
	// review ran the harmless printf without user input; user review opened a menu.
	auto := "\x1b]7501;state=idle:app=codex\x1b\\\x1b]7501;state=working:app=codex\x1b\\"
	require.Equal(t, "working", CodexCLIState([]byte(auto)))
	blocked := auto + "\x1b]7501;state=blocked:app=codex\x1b\\"
	require.Equal(t, "blocked", CodexCLIState([]byte(blocked)))
	require.Equal(t, "idle", CodexCLIState([]byte(blocked+"\x1b]7501;state=idle:app=codex\a")))
	for _, tail := range []string{"\x1b]7501;state=working:app=codex", "\x1b]7501;state=blocked:app=other\a", "\x1b]7501;state=unknown:app=codex\a"} {
		require.Empty(t, CodexCLIState([]byte(blocked+tail)))
	}
	require.Empty(t, CodexCLIState([]byte("quoted state=blocked:app=codex")))
}

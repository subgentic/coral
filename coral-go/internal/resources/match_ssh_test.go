package resources

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14170: a test that runs on ANOTHER machine over ssh is that machine's work, never this Mac's: the Mac's patterns must not match the text inside an ssh command's quoted or here-doc'd remote command. (The Orchestrator saw a Mac slot
// claimed beside an epoch-go claim; this pins every ssh shape tried so far. If a shape still claims, the exact command is the thing to add here.)
func TestATestRunOverSshIsNotMatchedByTheLocalPatterns(t *testing.T) {
	mac := []string{"go test ./...", "go test ./internal/server/routes", "go test ./internal/server", "go test internal/server/routes", "node run_cdp_suites.mjs", "npm run test:cloud", "make test"}
	for _, c := range []string{
		`ssh epoch 'bash -lc "cd ~/coral && go test ./internal/server/routes"'`,
		`ssh epoch "cd x && go test ./..."`,
		`coral-board resource claim epoch-go --wait && ssh epoch 'go test ./...'`,
		`coral-board resource claim epoch-go --wait >/dev/null && { ssh epoch 'bash -lc "cd ~/coral && git fetch -q origin b && go test ./internal/server/routes 2>&1 | tail -8; go test ./internal/agent"' 2>&1 | tail -30; coral-board resource release epoch-go; }`,
		`ssh epoch bash -lc 'go test ./internal/server/routes'`,
		"ssh epoch <<'EOF'\ngo test ./internal/server/routes\nEOF",
		`ssh -o ExitOnForwardFailure=no epoch 'go test ./internal/server/routes' | tail`,
		`ssh epoch 'cd ~/coral && node run_cdp_suites.mjs'`,
		`ssh epoch 'make test'`,
	} {
		_, hit := MatchCommand(c, mac)
		assert.False(t, hit, "a remote test is not a local one: %s", c)
	}
	// and a local test next to an ssh command is still the Mac's
	_, hit := MatchCommand(`ssh epoch ls; go test ./internal/server/routes`, mac)
	assert.True(t, hit)
}

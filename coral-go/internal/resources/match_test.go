package resources

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #13645: which commands claim a resource. Only a command in COMMAND POSITION counts, and only when every word of the pattern is in it, in order.
func TestWhichCommandsMatchAPattern(t *testing.T) {
	pats := []string{"go test ./...", "node run_cdp_suites.mjs", "npm run test:cloud"}
	for _, yes := range []string{
		"go test ./...",
		"cd coral-go && go test -count=1 ./... 2>&1 | tail -5",
		"CGO_ENABLED=0 go test -race ./...",
		"time go test ./...",
		"sudo -u build /usr/local/go/bin/go test ./...",
		"bash -c 'cd x && go test ./...'",
		"timeout 600 go test ./... > out.log",
		"echo start; (cd tests/frontend && CDP_FULL=1 node run_cdp_suites.mjs --only x --retries 0)",
		"npm --prefix tests/frontend run test:cloud",
		"nohup go test ./... &",
		"x=$(go test ./...)",
	} {
		_, ok := MatchCommand(yes, pats)
		assert.True(t, ok, "must claim: %s", yes)
	}
	for _, no := range []string{
		"go test -run TestOne ./internal/one",
		"go build ./...",
		`echo "go test ./..."`,
		"echo go test ./...",
		"ls go test ./...",
		`git commit -m "go test ./... is slow"`,
		"cat <<'EOF'\ngo test ./...\nEOF",
		"grep 'go test ./...' notes.md",
		"gofmt -l .",
		"npm run lint",
		"",
	} {
		_, ok := MatchCommand(no, pats)
		assert.False(t, ok, "must not claim: %q", no)
	}
	p, _ := MatchCommand("cd x && npm run test:cloud", pats)
	assert.Equal(t, "npm run test:cloud", p, "the answer is the manager's own pattern, never the command")
}

func TestACommandPastTheBoundsMatchesNothing(t *testing.T) {
	_, ok := MatchCommand("go test ./...\n"+strings.Repeat("echo x\n", 40000), []string{"go test ./..."})
	assert.False(t, ok, "a command the reader will not read is let run")
	_, ok = MatchCommand("go test ./...", nil)
	assert.False(t, ok, "no patterns, no hook")
}

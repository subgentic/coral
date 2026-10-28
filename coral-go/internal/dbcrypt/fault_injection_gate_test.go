package dbcrypt

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10014: the migration fault injection (an exit at a swap boundary, set by an environment variable) is gated on registered test flags only (testguard.InTestRun), never on the binary's name
// or its -test.* arguments (testguard.InTest), which whoever launches a shipped coral controls along with its environment. The wider check is for the package-init scrub in testguard/env.go.
func TestMigrationFaultInjectionAsksOnlyTheRegisteredTestFlags(t *testing.T) {
	src, err := os.ReadFile("dbcrypt.go")
	require.NoError(t, err)
	body := string(src)
	i := strings.Index(body, "func migrationFaultInjection(")
	require.GreaterOrEqual(t, i, 0)
	fn := body[i:]
	if j := strings.Index(fn, "\n}\n"); j >= 0 {
		fn = fn[:j]
	}
	assert.Contains(t, fn, "testguard.InTestRun()")
	assert.NotContains(t, fn, "testguard.InTest()")
}

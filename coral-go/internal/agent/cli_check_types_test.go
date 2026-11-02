package agent

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #12188: tools/gen_route_queries.py says a Go test keeps the types the Coral Hub lets through GET /api/system/cli-check equal to the agent types that have a CLI (agentCLIs), and there was none: OpenCode and
// Hermes were each missing from the Hub's list while a computer reached through the Hub could not check them. The generated line is read as text here (the tunnel package is not imported), so a new agent
// type in agentCLIs fails this test until the generator's list and routes_query.go have it.
func TestHubCLICheckTypesAreEveryAgentCLI(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "pkg", "tunnel", "routes_query.go"))
	require.NoError(t, err)
	m := regexp.MustCompile(`"GET /api/system/cli-check":\s*"[^"]*\btype=([a-z|]+)`).FindSubmatch(src)
	require.NotNil(t, m, "the cli-check line in pkg/tunnel/routes_query.go has no type= list")
	hub := strings.Split(string(m[1]), "|")
	var have []string
	for typ := range agentCLIs {
		have = append(have, typ)
	}
	sort.Strings(have)
	sort.Strings(hub)
	require.Equal(t, have, hub, "tools/gen_route_queries.py's cli-check type list (and the regenerated pkg/tunnel/routes_query.go, and CLI_CHECK_TYPES in server_base.js) must name exactly the agent types in agentCLIs")
	require.False(t, slices.Contains(hub, "terminal"), "a terminal has no CLI to check")
}

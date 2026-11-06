package server

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #13883: every owner POST of a board, and who the handler thinks the Hub owner is.
//
// TunnelIdentityGuard lets every POST on an owner route of the tunnel table pass without making it the Operator's (isHubSwitchRoute), so on those routes the identity layer names the Hub user's LABEL, not
// "Operator". A handler that reads the actor's name (actorName, callerActor, IsOperator, operatorWrites, attributedTo, hubOperatorUser) therefore refuses the owner unless it takes the owner as the Operator
// itself; close (Dismiss of a question) did not, and answered 403 not_allowed at v2.0.56. Its test built the Operator actor by hand and never ran the guard.
//
// This table is the one list of the owner's board POSTs. It fails when
//  1. an owner POST route of the table under /api/board/ has no row (a new owner route has to join, and say whether its handler reads the actor's name),
//  2. a row names a route that is not an owner POST route any more,
//  3. the handler (found through register_board_routes.golden, and the helper methods it calls on the same type, two levels down) reads the actor's name and the row does not name the end-to-end test that
//     runs it behind the real guard, or the row names one and the handler no longer reads a name,
//  4. the test a row names does not exist or does not run TunnelIdentityGuard.
//
// Owner POSTs outside /api/board/ (artifact comments, saved, dismiss-wait, notices, update, hub switches...) are not served behind this guard at all (tunnelBoardProject finds no board), so they are not in it.
//
// What it cannot see: a name read by a function the handler reaches through a package function or a field (it follows methods called on the handler's own receiver only), and a handler that reads the name
// under another spelling than the ones above. A new spelling needs a line in nameReads.

type ownerPost struct {
	deepTest string // the test that runs the real guard and this handler, when the handler reads the actor's name
	note     string
}

var ownerBoardPosts = map[string]ownerPost{
	"POST /api/board/{}/asks/{}/close":              {"TestTheOwnersIgnoreAndUndoWorkThroughTheRealGuard", "Ignore and Undo of a question: reads the actor's name to decide who may close; takes the verified Hub owner as the Operator itself (#13883)"},
	"POST /api/board/{}/asks/{}/buttons/{}/claim":   {"", "a button's click: person-gated by humanInputCaller, no name read"},
	"POST /api/board/{}/asks/{}/buttons/{}/settle":  {"", "the second half of a button's click: person-gated, no name read"},
	"POST /api/board/{}/proposals/{}/approve":       {"", "the Operator's decision on a proposal: person-gated, no name read"},
	"POST /api/board/{}/proposals/{}/reject":        {"", "the Operator's decision on a proposal: person-gated, no name read"},
	"POST /api/board/{}/goals/{}/driver":            {"", "who drives a goal: person-gated, no name read"},
	"POST /api/board/{}/goals/{}/move":              {"", "which team a goal is on: person-gated, no name read"},
	"POST /api/board/{}/artifacts/{}/review":        {"", "approve or ask change on an artifact: person-gated, no name read"},
	"POST /api/board/{}/artifacts/{}/edit":          {"", "the editor's save: person-gated, no name read"},
	"POST /api/board/{}/artifacts/{}/edit/send":     {"", "Send to agent with the diff: person-gated, no name read"},
	"POST /api/board/{}/operator-artifacts":         {"", "a file the Operator shares with an agent: no name read"},
	"POST /api/board/{}/operator-artifacts/message": {"", "the message that tells the agent: no name read"},
	"POST /api/board/{}/goal-images":                {"", "a picture for a goal's description: no name read"},
	"POST /api/board/{}/cross-team/enable":          {"", "the four Hub switch routes do their own owner check and record (#5572)"},
	"POST /api/board/{}/cross-team/disable":         {"", "the four Hub switch routes do their own owner check and record (#5572)"},
	"POST /api/board/{}/cross-team/files/enable":    {"", "the four Hub switch routes do their own owner check and record (#5572)"},
	"POST /api/board/{}/cross-team/files/disable":   {"", "the four Hub switch routes do their own owner check and record (#5572)"},
}

// nameReads: the ways a handler asks who the caller is by name.
var nameReads = []string{"actorName(", "callerActor(", ".IsOperator()", "operatorWrites(", "attributedTo(", "hubOperatorUser(", "ActorOf("}

var braceRe = regexp.MustCompile(`\{[^}]*\}`)

func shapeOfRoute(r string) string { return braceRe.ReplaceAllString(r, "{}") }

// funcBodies reads every non-test Go file of the handler packages once: "Type.name" -> body text.
func funcBodies(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	re := regexp.MustCompile(`(?m)^func \(\w+ \*?(\w+)\) (\w+)\(`)
	for _, dir := range []string{"routes", "."} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		require.NoError(t, err)
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, err := os.ReadFile(f)
			require.NoError(t, err)
			src := string(b)
			starts := regexp.MustCompile(`(?m)^func `).FindAllStringIndex(src, -1)
			for i, st := range starts {
				end := len(src)
				if i+1 < len(starts) {
					end = starts[i+1][0]
				}
				if m := re.FindStringSubmatch(src[st[0]:end]); m != nil {
					out[m[1]+"."+m[2]] = src[st[0]:end]
				}
			}
		}
	}
	return out
}

// readsName reports whether the method, or a method of the same type it calls (to depth), asks who the caller is.
func readsName(bodies map[string]string, typ, name string, depth int, seen map[string]bool) bool {
	key := typ + "." + name
	body, ok := bodies[key]
	if !ok || seen[key] {
		return false
	}
	seen[key] = true
	for _, n := range nameReads {
		if strings.Contains(body, n) {
			return true
		}
	}
	if depth == 0 {
		return false
	}
	recv := regexp.MustCompile(`^func \((\w+) `).FindStringSubmatch(body)
	if recv == nil {
		return false
	}
	// only methods called on the receiver itself: h.bs.CloseAsk( is the store's, not the handler's
	for _, m := range regexp.MustCompile(`(?:^|[^.\w])`+recv[1]+`\.(\w+)\(`).FindAllStringSubmatch(body, -1) {
		if readsName(bodies, typ, m[1], depth-1, seen) {
			return true
		}
	}
	return false
}

func TestEveryOwnerBoardPostSaysWhetherItsHandlerReadsTheActorsName(t *testing.T) {
	golden, err := os.ReadFile("testdata/register_board_routes.golden")
	require.NoError(t, err)
	handlerOf := map[string][2]string{} // shape -> type, method
	hre := regexp.MustCompile(`^(POST \S+) \| \(\*(\w+)\)\.(\w+)-fm$`)
	for _, l := range strings.Split(string(golden), "\n") {
		if m := hre.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			handlerOf[shapeOfRoute(m[1])] = [2]string{m[2], m[3]}
		}
	}
	bodies := funcBodies(t)

	inTable := map[string]bool{}
	for _, route := range tunnel.OwnerRoutes() {
		if route.Method != "POST" || !route.Mode.Refuses() || !strings.HasPrefix(route.Pattern, "/api/board/") {
			continue
		}
		shape := shapeOfRoute("POST " + route.Pattern)
		inTable[shape] = true
		row, ok := ownerBoardPosts[shape]
		require.True(t, ok, "%s is an owner POST of a board and has no row in ownerBoardPosts: say whether its handler reads the actor's name (TunnelIdentityGuard does not make the Hub owner the Operator on an owner route) and, if it does, name the test that runs it behind the real guard", shape)
		h, ok := handlerOf[shape]
		require.True(t, ok, "%s: the handler is not in register_board_routes.golden", shape)
		reads := readsName(bodies, h[0], h[1], 2, map[string]bool{})
		require.NotEmpty(t, row.note, shape)
		if reads {
			require.NotEmpty(t, row.deepTest, "%s: %s.%s reads the actor's name, and on an owner route the Hub owner's name is a label, not Operator: name the test that runs it behind the real guard, or take the owner as the Operator in the handler", shape, h[0], h[1])
		} else {
			require.Empty(t, row.deepTest, "%s: %s.%s no longer reads the actor's name: drop the test from the row", shape, h[0], h[1])
		}
		if row.deepTest != "" {
			found := false
			files, _ := filepath.Glob("routes/*_test.go")
			for _, f := range files {
				b, _ := os.ReadFile(f)
				src := string(b)
				if i := strings.Index(src, "func "+row.deepTest+"("); i >= 0 {
					found = true
					j := strings.Index(src[i+1:], "\nfunc ")
					if j < 0 {
						j = len(src) - i - 1
					}
					require.Contains(t, src[i:i+1+j]+src, "viaGuard(", "%s must run the real guard", row.deepTest)
					require.Contains(t, src[i:i+1+j], "viaGuard(", "%s must call viaGuard", row.deepTest)
				}
			}
			require.True(t, found, "%s: the test %s does not exist", shape, row.deepTest)
		}
	}
	var stale []string
	for shape := range ownerBoardPosts {
		if !inTable[shape] {
			stale = append(stale, shape)
		}
	}
	sort.Strings(stale)
	require.Empty(t, stale, "rows for routes that are not owner POSTs of a board any more: delete them")
	require.GreaterOrEqual(t, len(inTable), 17)
}

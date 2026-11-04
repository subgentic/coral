package tunnel

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13502: the dashboard's shell sent series=1 on a route whose table row did not list it, and through Coral Hub every Inbox click on a file ended in "path_not_allowed". Nothing compared what the shell sends
// with what the connector admits. This census reads every query the shell's scripts build on an /api path (a literal or a template, including a flag added inside a ${ } like `${series ? '&series=1' : ''}`),
// and fails for a name the route's row does not list. A name the shell sends on a route the table has no row for is not judged here (the connector refuses the whole route, or it is not routed).

var (
	apiTemplateRe = regexp.MustCompile("`[^`]*`|'[^'\\n]*'|\"[^\"\\n]*\"")
	interpRe      = regexp.MustCompile(`\$\{[^}]*\}`)
	queryKeyRe    = regexp.MustCompile(`[?&]([A-Za-z_][A-Za-z0-9_\-]*)=`)
	// a helper that names a route: const base = (hex, server) => serverUrl(`/api/artifacts/${hex}/comments`, server);
	helperRe = regexp.MustCompile("(?m)^(?:export\\s+)?const\\s+(\\w+)\\s*=\\s*\\([^)]*\\)\\s*=>[^\\n]*?(/api/[^\\s'\"`?)]*)")
	// a template that starts with a call of one: `${base(hex, server)}?state=all`
	helperCallRe = regexp.MustCompile("^`\\$\\{(\\w+)\\([^}]*\\}")
)

// shellQueryGaps names every "path ? name (file)" the shell's scripts send that the table does not list for that route shape.
func shellQueryGaps(table map[string]string, staticDir string) ([]string, error) {
	allowed := map[string]map[string]bool{} // route shape -> names, any method
	for k, spec := range table {
		_, shape, _ := strings.Cut(k, " ")
		if allowed[shape] == nil {
			allowed[shape] = map[string]bool{}
		}
		for _, p := range strings.Split(spec, ",") {
			name, _, _ := strings.Cut(strings.TrimSuffix(p, "*"), "=")
			if name != "" {
				allowed[shape][name] = true
			}
		}
	}
	files, err := filepath.Glob(filepath.Join(staticDir, "*.js"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	seen := map[string]bool{}
	var gaps []string
	for _, f := range files {
		if strings.HasSuffix(f, ".test.js") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		src := string(b)
		helpers := map[string]string{}
		for _, m := range helperRe.FindAllStringSubmatch(src, -1) {
			helpers[m[1]] = m[2]
		}
		for _, lit := range apiTemplateRe.FindAllString(src, -1) {
			i := strings.Index(lit, "/api/")
			rest := ""
			if i >= 0 {
				rest = lit[i:]
			} else if m := helperCallRe.FindStringSubmatch(lit); m != nil && helpers[m[1]] != "" {
				rest = helpers[m[1]] + lit[len(m[0]):] // the helper's route, then what the template adds to it
			} else {
				continue
			}
			j := strings.Index(rest, "?")
			if j < 0 {
				continue
			}
			shape := strings.TrimRight(interpRe.ReplaceAllString(rest[:j], "{}"), "/")
			names, known := allowed[shape]
			if !known {
				continue
			}
			for _, m := range queryKeyRe.FindAllStringSubmatch(rest[j:], -1) {
				if names[m[1]] {
					continue
				}
				g := shape + " ? " + m[1] + " (" + filepath.Base(f) + ")"
				if !seen[g] {
					seen[g] = true
					gaps = append(gaps, g)
				}
			}
		}
	}
	return gaps, nil
}

// What the shell sends and the table does not list, kept with the reason: the Operator's own check by path, which the table deliberately drops (the handler refuses a tunneled one).
var shellQueriesKnownGaps = map[string]string{
	"/api/system/cli-check ? binary (cli_dialogs.js)": "the check by path runs a binary the caller names: the Operator's, on this computer only (gen_route_queries.py DROP)",
}

func TestEveryQueryTheShellSendsIsOnTheConnectorsTable(t *testing.T) {
	gaps, err := shellQueryGaps(routeQueries, filepath.Join("..", "frontend", "static"))
	require.NoError(t, err)
	var unexplained []string
	for _, g := range gaps {
		if _, ok := shellQueriesKnownGaps[g]; !ok {
			unexplained = append(unexplained, g)
		}
	}
	assert.Empty(t, unexplained, "the shell sends a query the connector refuses: list it in tools/gen_route_queries.py (EXTRA, with the reason) and regenerate, or stop sending it")
	for g := range shellQueriesKnownGaps {
		assert.Contains(t, gaps, g, "a known gap that is gone must leave this list")
	}
}

// The census sees a flag added inside a template's ${ }, which is how series=1 was sent: with that name off the row it is a gap.
func TestTheCensusSeesTheSeriesFlagWhenTheRowLacksIt(t *testing.T) {
	table := map[string]string{}
	for k, v := range routeQueries {
		table[k] = v
	}
	table["GET /api/artifacts/{}/comments"] = "board,state"
	gaps, err := shellQueryGaps(table, filepath.Join("..", "frontend", "static"))
	require.NoError(t, err)
	assert.Contains(t, gaps, "/api/artifacts/{}/comments ? series (artifact_comments_api.js)")
}

package routes

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9265: a server post that quotes stored text (a title, a message, a note, a reason, a candidate) must be defused, or it tags the members the text names. noticeText + postNotice do that, so
// Store.PostSystemMessage (which cleans its text, and so cannot carry the defusing) may be called only from the functions below, each of which posts text Coral wrote itself and names only
// members (the names are cleaned and have no "@"). A new call anywhere else fails here: quote what is stored with h.noticeText and post it with h.postNotice.
var systemPostAllowed = map[string]struct {
	calls  int
	reason string
}{
	"routes/agent_exit.go postExitNotice":              {1, "the stopped agents' cleaned names, a fixed label and a fixed plan"},
	"routes/agent_exit.go autoResume":                  {1, "a live @title and a constant sentence"},
	"routes/auto_review.go autoDelegateReview":         {3, "reviewer names through teamhealth.Name, task numbers, fixed words"},
	"routes/auto_review.go healthBudgetReached":        {1, "a live @orchestrator and a number"},
	"routes/auto_wake.go sendAutoWakeNotice":           {1, "a live @title and a constant sentence"},
	"routes/board_goal_requests.go wakeForGoalRequest": {1, "Coral's own how-to sentence with a request number"},
	"routes/task_park.go ParkTask":                     {2, "teamhealth.Name of who, a time, task numbers; the park reason stays on the task"},
	"background/board_health_roster.go escalateWaits":  {1, "two cleaned names and an age"},
	"background/health_held.go heldNotice":             {1, "cleaned names and minutes"},
	"background/health_nudges.go postLines":            {2, "cleaned names; a budget number"},
	"background/health_remind.go RunOnce":              {1, "a task number, a time and a target name"},
}

func TestEveryServerPostThatQuotesStoredTextIsDefused(t *testing.T) {
	found := map[string]int{}
	var defusedOutsidePostNotice []string
	for _, dir := range []string{".", "../../background"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		require.NoError(t, err)
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			af, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
			require.NoError(t, err)
			pkg := "routes"
			if dir != "." {
				pkg = "background"
			}
			for _, d := range af.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					c, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					sel, ok := c.Fun.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					switch sel.Sel.Name {
					case "PostSystemMessage":
						found[pkg+"/"+filepath.Base(f)+" "+fd.Name.Name]++
					case "PostSystemDefusedMessage":
						if fd.Name.Name != "postNotice" {
							defusedOutsidePostNotice = append(defusedOutsidePostNotice, pkg+"/"+filepath.Base(f)+" "+fd.Name.Name)
						}
					}
					return true
				})
			}
		}
	}
	var keys []string
	for k := range found {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		allowed, ok := systemPostAllowed[k]
		if !assert.True(t, ok, "%s posts with PostSystemMessage: if it quotes stored text, defuse it with h.noticeText and post it with h.postNotice; if it posts only text Coral wrote and cleaned names, add it to systemPostAllowed with the reason", k) {
			continue
		}
		assert.Equal(t, allowed.calls, found[k], "%s: the number of PostSystemMessage calls changed; a new one needs the same review (%s)", k, allowed.reason)
	}
	for k := range systemPostAllowed {
		assert.Contains(t, found, k, "%s no longer posts with PostSystemMessage: take it off the list", k)
	}
	assert.Empty(t, defusedOutsidePostNotice, "PostSystemDefusedMessage stores its text as given: only postNotice, after noticeText, may call it")
}

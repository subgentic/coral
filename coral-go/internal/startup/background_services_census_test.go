package startup

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The background services startBackgroundServices starts, by name and in the order it starts them (#8272). It reads the startup source, follows
// every call startBackgroundServices makes to a function of this package in place (so a service moved into a helper keeps its place in the order),
// and lists the first argument of each safeGo, safego.Go and safego.Restart call. Splitting the function into groups must leave this list as it is:
// a service dropped, started twice, or started in another order (the scheduler before the board notifier, the workflow runner last) fails here.
var startedServices = []string{
	"cloud_connector", "remote_agents", "git_poller", "session_indexer", "job_scheduler", "board_notifier", "board_health_monitor", "health_nudges",
	"task_reminders", "remote_board_poller", "batch_summarizer", "goal_generator", "session_reconciler", "token_poller",
	"call_metrics_retention", "token_usage_retention", "token_usage_hour_agg", "db_optimize", "db_integrity", "startup/auto_wake",
	"uploads_retention", "artifact_retention", "dialog_watch", "thinking_tracker",
}

func TestBackgroundServicesStartInTheSameOrder(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "startup_services.go", nil, 0)
	require.NoError(t, err)
	funcs := map[string]*ast.FuncDecl{}
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Recv == nil {
			funcs[fd.Name.Name] = fd
		}
	}
	root := funcs["startBackgroundServices"]
	require.NotNil(t, root)
	var names []string
	seen := map[string]bool{}
	var walk func(n ast.Node)
	walk = func(n ast.Node) {
		ast.Inspect(n, func(n ast.Node) bool {
			c, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			callee := ""
			switch fn := c.Fun.(type) {
			case *ast.Ident:
				callee = fn.Name
			case *ast.SelectorExpr:
				if x, ok := fn.X.(*ast.Ident); ok {
					callee = x.Name + "." + fn.Sel.Name
				}
			}
			switch callee {
			case "safeGo":
				if len(c.Args) >= 2 {
					names = append(names, lit(t, c.Args[1]))
				}
			case "safego.Go", "safego.Restart":
				if len(c.Args) >= 1 {
					names = append(names, lit(t, c.Args[0]))
				}
			default:
				if fd, ok := funcs[callee]; ok && callee != "safeGo" && !seen[callee] && callee != "startBackgroundServices" {
					seen[callee] = true
					// a function that starts nothing (a store constructor) adds nothing; one that does is entered where it is called
					walk(fd.Body)
				}
			}
			return true
		})
	}
	walk(root.Body)
	assert.Equal(t, startedServices, names)
	// every service of the list is a string literal name without spaces: the name is what the crash log and the restart backoff say
	for _, n := range names {
		assert.False(t, strings.ContainsAny(n, " \t"), n)
	}
}

func lit(t *testing.T, e ast.Expr) string {
	t.Helper()
	bl, ok := e.(*ast.BasicLit)
	require.True(t, ok, "a service name is a string literal")
	s, err := strconv.Unquote(bl.Value)
	require.NoError(t, err)
	return s
}

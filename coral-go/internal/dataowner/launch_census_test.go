package dataowner

import (
	"fmt"
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

// The one-gate rule for what starts, resumes or ends an agent (Security's SHOULD on #277): a Coral on a copy of another's database (FOREIGN) must not launch, resume, kill or type by itself, and
// the next background loop somebody adds must not reopen the 2026-11-01 incident. So every non-test function in internal/server/routes and internal/background that calls one of the launch or
// end primitives below is either
//   - an HTTP handler (it takes an http.ResponseWriter: a person's, or a Hub command's, action), or
//   - listed in pinnedSites with the reason it is safe, and, where the reason is "gated", the census checks that the function (or the loop entry it names) asks ptymanager.Foreign or
//     ptymanager.RefuseIfForeign.
//
// A new function that calls a primitive fails here until a reviewer lists it. A listed one that no longer exists fails too.
var primitives = map[string]bool{
	"Spawn": true, "CreateSession": true, "RestartPane": true,
	"KillAgent": true, "KillSession": true, "KillSessionOnly": true,
	"LaunchAgent": true, "wakeExistingSession": true,
}

const (
	person = "person-triggered"
	gated  = "gated"
)

// pinnedSites is "file Receiver.Function" -> "kind: why". "gated" ones must contain a Foreign gate themselves; the others are reached only through the named handlers or gated entries.
var pinnedSites = map[string]string{
	// the runtime implementations: reached through the launcher, the scheduler and the handlers below
	"runtime_pty.go PTYRuntime.SpawnAgent":   person + ": the runtime behind the launcher, the scheduler and the launch handlers",
	"runtime_tmux.go TmuxRuntime.SpawnAgent": person + ": the runtime behind the launcher, the scheduler and the launch handlers",
	"runtime_tmux.go TmuxRuntime.KillAgent":  person + ": the runtime behind the reconciler, the scheduler and the kill handlers",
	// the scheduler and the workflow runner
	"scheduler.go JobScheduler.killRunSession":                 gated + ": only reached from JobScheduler.Run's ticks (Run returns at once in a foreign Coral) and the run handlers",
	"scheduler_turn.go JobScheduler.endRunSession":             gated + ": only reached from JobScheduler.Run's ticks",
	"workflow_runner.go WorkflowRunner.KillRun":                person + ": the workflow run's kill handler",
	"workflow_steps.go WorkflowRunner.executeAgentInteractive": gated + ": the workflow agent step refuses itself",
	// the reconciler
	"reconciler.go SessionReconciler.killOrphans": gated + ": kills the real agents' sessions a copy lists as stopped",
	// what the handlers launch with
	"orchestrator_agents.go SessionsHandler.sleepNow":           person + ": the orchestrator's sleep handler",
	"sessions_launch_session.go SessionsHandler.startOnBackend": person + ": the launch handlers",
	"sessions_launch_session.go SessionsHandler.startOnTmux":    person + ": the launch handlers",
	"sessions_restart.go SessionsHandler.restartTerminal":       person + ": the restart and resume handlers",
	"sessions_wake.go SessionsHandler.startWake":                person + ": wakeExistingSession's own start, below",
	// the background resumes of a session
	"agent_exit.go SessionsHandler.autoResume": gated + ": the resume after an agent exit asks first",
	"auto_wake.go SessionsHandler.autoWakeOne": gated + ": only reached from AutoWakeAfterRestart, which returns at once in a foreign Coral",
}

// gatedEntries are the loop entries and functions that must ask the gate in their own body.
var gatedEntries = []string{
	"reconciler.go SessionReconciler.Run",
	"reconciler.go SessionReconciler.killOrphans",
	"scheduler.go JobScheduler.Run",
	"workflow_steps.go WorkflowRunner.executeAgentInteractive",
	"agent_exit.go SessionsHandler.autoResume",
	"auto_wake.go SessionsHandler.AutoWakeAfterRestart",
	"dialog_watch.go SessionsHandler.RunDialogWatch",
	"auto_accept.go AutoAcceptor.Run",
}

type fnInfo struct {
	key     string
	handler bool
	calls   []string
	gate    bool
}

func scan(t *testing.T) map[string]*fnInfo {
	t.Helper()
	out := map[string]*fnInfo{}
	for _, dir := range []string{"../server/routes", "../background"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		require.NoError(t, err)
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			af, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
			require.NoError(t, err, f)
			for _, d := range af.Decls {
				fn, ok := d.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				name := fn.Name.Name
				if fn.Recv != nil && len(fn.Recv.List) > 0 {
					typ := fn.Recv.List[0].Type
					if st, ok := typ.(*ast.StarExpr); ok {
						typ = st.X
					}
					if id, ok := typ.(*ast.Ident); ok {
						name = id.Name + "." + name
					}
				}
				info := &fnInfo{key: filepath.Base(f) + " " + name}
				for _, p := range fn.Type.Params.List {
					if sel, ok := p.Type.(*ast.SelectorExpr); ok && sel.Sel.Name == "ResponseWriter" {
						info.handler = true
					}
				}
				seen := map[string]bool{}
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					c, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					var callee string
					switch f := c.Fun.(type) {
					case *ast.SelectorExpr:
						callee = f.Sel.Name
					case *ast.Ident:
						callee = f.Name
					}
					if primitives[callee] && !seen[callee] {
						seen[callee] = true
						info.calls = append(info.calls, callee)
					}
					if callee == "Foreign" || callee == "RefuseIfForeign" {
						info.gate = true
					}
					return true
				})
				sort.Strings(info.calls)
				if prev, dup := out[info.key]; dup { // the same name twice in a package folder pair: keep both facts
					prev.calls = append(prev.calls, info.calls...)
					prev.gate = prev.gate || info.gate
					prev.handler = prev.handler || info.handler
					continue
				}
				out[info.key] = info
			}
		}
	}
	return out
}

func TestEveryFunctionThatLaunchesOrEndsAnAgentIsAHandlerOrListed(t *testing.T) {
	all := scan(t)
	var unlisted []string
	for key, fn := range all {
		if len(fn.calls) == 0 || fn.handler {
			continue
		}
		if _, ok := pinnedSites[key]; !ok {
			unlisted = append(unlisted, fmt.Sprintf("%s calls %v", key, fn.calls))
		}
	}
	sort.Strings(unlisted)
	assert.Empty(t, unlisted, "a function that launches, resumes or ends an agent must be an HTTP handler (a person's action) or be listed in pinnedSites with why it is safe in a foreign Coral (and, if gated, ask ptymanager.Foreign / RefuseIfForeign)")
	for key := range pinnedSites {
		fn, ok := all[key]
		if assert.True(t, ok, "%s is listed but no longer exists: take it off the list", key) {
			assert.NotEmpty(t, fn.calls, "%s no longer calls a launch or end primitive: take it off the list", key)
		}
	}
}

func TestTheGatedEntriesAskTheForeignGate(t *testing.T) {
	all := scan(t)
	for _, key := range gatedEntries {
		fn, ok := all[key]
		if assert.True(t, ok, "%s not found", key) {
			assert.True(t, fn.gate, "%s must ask ptymanager.Foreign or RefuseIfForeign in its body", key)
		}
	}
	for key, why := range pinnedSites {
		if strings.HasPrefix(why, gated) {
			found := false
			for _, g := range gatedEntries {
				found = found || g == key
			}
			if !found {
				// a gated site that is not itself an entry: reached only through entries listed above (named in its reason)
				assert.Contains(t, why, "only reached from", key)
			}
		}
	}
}

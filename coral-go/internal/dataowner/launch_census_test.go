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
//
// SCOPE: internal/server/routes and internal/background only. A launcher added in another package (internal/startup, internal/server, cmd) is not seen by this census; such a package must be added
// to scanDirs when it gains one. The second pass (TestEveryCallerOfAPersonTriggeredFunctionIsAHandlerListedOrGated) covers the callers of the helpers pinned below.
var primitives = map[string]bool{
	"Spawn": true, "CreateSession": true, "RestartPane": true,
	"KillAgent": true, "KillSession": true, "KillSessionOnly": true,
	"LaunchAgent": true, "wakeExistingSession": true,
}

// scanDirs are the folders the census reads (see SCOPE above).
var scanDirs = []string{"../server/routes", "../background"}

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
	callees map[string]bool // every function called by name in the body
	gate    bool
}

func scan(t *testing.T) map[string]*fnInfo {
	t.Helper()
	out := map[string]*fnInfo{}
	for _, dir := range scanDirs {
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
				info := &fnInfo{key: filepath.Base(f) + " " + name, callees: map[string]bool{}}
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
					info.callees[callee] = true
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
					for c := range info.callees {
						prev.callees[c] = true
					}
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

// guardedHelpers are the helpers pinned above as reached only from a person's action or a gated entry. The second pass: every function that CALLS one of them is itself an HTTP handler, pinned in
// pinnedSites or gatedEntries, or listed in pinnedCallers with why. So a new background caller of startWake or restartTerminal cannot slip past the first pass, which only sees the primitives.
var guardedHelpers = []string{"startOnBackend", "startOnTmux", "restartTerminal", "startWake", "sleepNow", "killRunSession", "endRunSession", "autoWakeOne", "launchSession", "wakeExistingSession"}

// pinnedCallers are the callers of the guarded helpers that are neither handlers nor pinned above: each is reached only from the handler or gated entry named.
var pinnedCallers = map[string]string{
	"scheduler.go JobScheduler.KillRun":                        "the run-kill handler (tasks.go) and the workflow run handlers",
	"scheduler.go JobScheduler.finishRun":                      "only reached from the scheduler's ticks and watchers (JobScheduler.Run returns at once in a foreign Coral) or a run a person started",
	"scheduler_reap.go JobScheduler.reapStaleRuns":             "only reached from JobScheduler.Run, which returns at once in a foreign Coral",
	"scheduler_turn.go JobScheduler.settleOnTurn":              "only reached from the scheduler's turn watchers (started by Run or by a run a person started)",
	"sessions_launch_session.go SessionsHandler.launchSession": "the launch, team launch, team lifecycle and team reset handlers",
	"sessions_launch_team.go SessionsHandler.launchTeamMember": "the team launch handlers",
	"sessions_wake.go SessionsHandler.wakeExistingSession":     "the wake handlers; its two background callers (autoResume, autoWakeOne) are gated entries",
}

func TestEveryCallerOfAPersonTriggeredFunctionIsAHandlerListedOrGated(t *testing.T) {
	all := scan(t)
	isGuarded := map[string]bool{}
	for _, h := range guardedHelpers {
		isGuarded[h] = true
	}
	var unknown []string
	for key, fn := range all {
		if fn.handler {
			continue
		}
		var hits []string
		for h := range isGuarded {
			if fn.callees[h] && !strings.HasSuffix(key, " "+h) && !strings.HasSuffix(key, "."+h) {
				hits = append(hits, h)
			}
		}
		if len(hits) == 0 {
			continue
		}
		_, pinned := pinnedSites[key]
		_, extra := pinnedCallers[key]
		gate := false
		for _, g := range gatedEntries {
			gate = gate || g == key
		}
		if !pinned && !extra && !gate {
			sort.Strings(hits)
			unknown = append(unknown, fmt.Sprintf("%s calls %v", key, hits))
		}
	}
	sort.Strings(unknown)
	assert.Empty(t, unknown, "a function that calls a person-triggered helper must be an HTTP handler, or be listed in pinnedSites, gatedEntries or pinnedCallers")
	for key := range pinnedCallers {
		_, ok := all[key]
		assert.True(t, ok, "%s is listed in pinnedCallers but no longer exists", key)
	}
}

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

// A census of who may launch, resume, wake or end an agent (task #429, kept by #12603 after the data-folder check became a warning only; the foreign-gate half is gone). Coral never blocks on the
// data-folder check, so this is no longer about a gate: it is about knowing every place that starts or ends an agent. Every function in internal/server/routes and internal/background that calls a
// launch, resume or end primitive must be:
//   - an HTTP handler (it takes an http.ResponseWriter: a person's, or a Hub command's, action), or
//   - listed in pinnedSites with the reason it is safe: who reaches it.
//
// A new function that calls a primitive fails here until a reviewer lists it. A listed one that no longer exists fails too. The second pass
// (TestEveryCallerOfAPersonTriggeredFunctionIsAHandlerListedOrGated) covers the callers of the helpers pinned below.
//
// SCOPE: internal/server/routes and internal/background only. A launcher added in another package (internal/startup, internal/server, cmd) is not seen by this census; such a package must be added to
// scanDirs when it gains one.
var primitives = map[string]bool{
	"Spawn": true, "CreateSession": true, "RestartPane": true,
	"KillAgent": true, "KillSession": true, "KillSessionOnly": true,
	"LaunchAgent": true, "wakeExistingSession": true, "wakeSession": true, // wakeSession is the wake itself: wakeExistingSession forwards to it, and so does WakeIdleFor (an agent woken without its starting prompt, #12358)
}

// scanDirs are the folders the census reads (see SCOPE above).
var scanDirs = []string{"../server/routes", "../background"}

const (
	person     = "person-triggered"
	background = "background"
)

// pinnedSites is "file Receiver.Function" -> "kind: why": reached only through the named handlers or background entries.
var pinnedSites = map[string]string{
	// the runtime implementations: reached through the launcher, the scheduler and the handlers below
	"runtime_pty.go PTYRuntime.SpawnAgent":   person + ": the runtime behind the launcher, the scheduler and the launch handlers",
	"runtime_tmux.go TmuxRuntime.SpawnAgent": person + ": the runtime behind the launcher, the scheduler and the launch handlers",
	"runtime_tmux.go TmuxRuntime.KillAgent":  person + ": the runtime behind the reconciler, the scheduler and the kill handlers",
	// the scheduler and the workflow runner
	"scheduler.go JobScheduler.killRunSession":                 background + ": only reached from JobScheduler.Run's ticks and the run handlers",
	"scheduler_turn.go JobScheduler.endRunSession":             background + ": only reached from JobScheduler.Run's ticks",
	"workflow_runner.go WorkflowRunner.KillRun":                person + ": the workflow run's kill handler",
	"workflow_steps.go WorkflowRunner.executeAgentInteractive": background + ": the workflow agent step, reached from the workflow runner",
	// the reconciler
	"reconciler.go SessionReconciler.killOrphans": background + ": the reconciler kills the orphan sessions of agents the database lists as stopped",
	// what the handlers launch with
	"orchestrator_agents.go SessionsHandler.sleepNow":           person + ": the orchestrator's sleep handler",
	"sessions_launch_session.go SessionsHandler.startOnBackend": person + ": the launch handlers",
	"sessions_launch_session.go SessionsHandler.startOnTmux":    person + ": the launch handlers",
	"sessions_restart.go SessionsHandler.restartTerminal":       person + ": the restart and resume handlers",
	"sessions_wake.go SessionsHandler.startWake":                person + ": wakeExistingSession's own start, below",
	"sessions_wake.go SessionsHandler.wakeExistingSession":      person + ": the wake handlers' wake; it only forwards to wakeSession, and its background callers are autoResume and autoWakeOne",
	// the background resumes of a session
	"agent_exit.go SessionsHandler.autoResume": background + ": the resume after an agent exit, from the exit watcher",
	"auto_wake.go SessionsHandler.autoWakeOne": background + ": only reached from AutoWakeAfterRestart",
	// auto-sleep (#12111): it ends a terminal by itself and a delivery wakes an agent by itself
	"auto_sleep.go SessionsHandler.autoSleepOne":     background + ": only reached from autoSleepPass, which RunAutoSleep runs",
	"auto_sleep_wake.go SessionsHandler.WakeIdleFor": background + ": an automated wake (a delivery's); a person's own Send is a person's action",
}

// backgroundEntries are the reviewed loop entries and functions that start or end agents on their own: the callers of the guarded helpers that are not handlers.
var backgroundEntries = []string{
	"reconciler.go SessionReconciler.Run",
	"reconciler.go SessionReconciler.killOrphans",
	"scheduler.go JobScheduler.Run",
	"workflow_steps.go WorkflowRunner.executeAgentInteractive",
	"agent_exit.go SessionsHandler.autoResume",
	"auto_wake.go SessionsHandler.AutoWakeAfterRestart",
	"auto_sleep.go SessionsHandler.RunAutoSleep",
	"auto_sleep.go SessionsHandler.autoSleepPass",
	"auto_sleep.go SessionsHandler.autoSleepOne",
	"auto_sleep_wake.go SessionsHandler.WakeIdleFor",
	"dialog_watch.go SessionsHandler.RunDialogWatch",
	"auto_accept.go AutoAcceptor.Run",
}

type fnInfo struct {
	key     string
	handler bool
	calls   []string
	callees map[string]bool // every function called by name in the body
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
					return true
				})
				sort.Strings(info.calls)
				if prev, dup := out[info.key]; dup { // the same name twice in a package folder pair: keep both facts
					prev.calls = append(prev.calls, info.calls...)
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
	assert.Empty(t, unlisted, "a function that launches, resumes or ends an agent must be an HTTP handler (a person's action) or be listed in pinnedSites with who reaches it")
	for key := range pinnedSites {
		fn, ok := all[key]
		if assert.True(t, ok, "%s is listed but no longer exists: take it off the list", key) {
			assert.NotEmpty(t, fn.calls, "%s no longer calls a launch or end primitive: take it off the list", key)
		}
	}
}

// guardedHelpers are the helpers pinned above as reached only from a person's action or a background entry. The second pass: every function that CALLS one of them is itself an HTTP handler, pinned in
// pinnedSites or backgroundEntries, or listed in pinnedCallers with why. So a new background caller of startWake or restartTerminal cannot slip past the first pass, which only sees the primitives.
var guardedHelpers = []string{"startOnBackend", "startOnTmux", "restartTerminal", "startWake", "sleepNow", "killRunSession", "endRunSession", "autoWakeOne", "launchSession", "wakeExistingSession", "wakeSession"}

// pinnedCallers are the callers of the guarded helpers that are neither handlers nor pinned above: each is reached only from the handler or background entry named.
var pinnedCallers = map[string]string{
	"scheduler.go JobScheduler.KillRun":                        "the run-kill handler (tasks.go) and the workflow run handlers",
	"scheduler.go JobScheduler.finishRun":                      "only reached from the scheduler's ticks and watchers or a run a person started",
	"scheduler_reap.go JobScheduler.reapStaleRuns":             "only reached from JobScheduler.Run",
	"scheduler_turn.go JobScheduler.settleOnTurn":              "only reached from the scheduler's turn watchers (started by Run or by a run a person started)",
	"sessions_launch_session.go SessionsHandler.launchSession": "the launch, team launch, team lifecycle and team reset handlers",
	"sessions_launch_team.go SessionsHandler.launchTeamMember": "the team launch handlers",
	"sessions_wake.go SessionsHandler.wakeExistingSession":     "the wake handlers; its two background callers are autoResume and autoWakeOne",
	"sessions_wake.go SessionsHandler.wakeSession":             "wakeExistingSession (the wake handlers and their background callers) and WakeIdleFor, a background entry",
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
		entry := false
		for _, g := range backgroundEntries {
			entry = entry || g == key
		}
		if !pinned && !extra && !entry {
			sort.Strings(hits)
			unknown = append(unknown, fmt.Sprintf("%s calls %v", key, hits))
		}
	}
	sort.Strings(unknown)
	assert.Empty(t, unknown, "a function that calls a person-triggered helper must be an HTTP handler, or be listed in pinnedSites, backgroundEntries or pinnedCallers")
	for key := range pinnedCallers {
		_, ok := all[key]
		assert.True(t, ok, "%s is listed in pinnedCallers but no longer exists", key)
	}
	for _, key := range backgroundEntries {
		_, ok := all[key]
		assert.True(t, ok, "%s is listed in backgroundEntries but no longer exists", key)
	}
}

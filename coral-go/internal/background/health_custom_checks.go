package background

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/healthcheck"
	"github.com/subgentic/coral/internal/naming"
)

// Concurrent check runs, in all (design v2 section 5.9). One check never runs twice at once.
const maxConcurrentChecks = 2

// CustomChecks runs the approved custom health checks when their time comes (#20137): each from its snapshot, with an environment built from nothing, one at a time per check and two at a time in all,
// and says what they print to the member it is for (the check's `to`, else the board's Orchestrator) as Coral's notice: once per key, a failure as one fixed line. A check that is pending, paused or
// whose record changed never runs.
type CustomChecks struct {
	store    *board.Store
	logger   *slog.Logger
	discover func(ctx context.Context) ([]AgentInfo, error)
	deliver  func(ctx context.Context, a AgentInfo, key, text string) error
	run      func(ctx context.Context, sp healthcheck.Spec) healthcheck.Result
	now      func() time.Time
	// Redact clears a line's text of secrets: false means it could not be cleared and the line says it is withheld. nil withholds every line.
	Redact   func(string) (string, bool)
	BoardURL string // the loopback URL a script's coral-board talks to
	// SnapDir is Coral's own folder of snapshots: a run's path is derived from the approved hash inside it, never read from the row (Security 4b).
	SnapDir  string
	Interval time.Duration
	sem      chan struct{}
	mu       sync.Mutex
	running  map[int64]bool
}

// NewCustomChecks looks for due checks every 30 seconds.
func NewCustomChecks(bs *board.Store, rt AgentRuntime, discover func(context.Context) ([]AgentInfo, error)) *CustomChecks {
	c := &CustomChecks{store: bs, logger: slog.Default(), discover: discover, now: time.Now, Interval: 30 * time.Second,
		run: healthcheck.Run, sem: make(chan struct{}, maxConcurrentChecks), running: map[int64]bool{}}
	c.deliver = func(ctx context.Context, a AgentInfo, _ string, text string) error {
		_, err := deliverAutomated(ctx, rt, c.logger, naming.SessionName(a.AgentType, a.SessionID), a.AgentType, a.SessionID, board.OneLine(text), "health check", false, false)
		return err
	}
	return c
}

// Run looks for due checks every Interval until ctx is done.
func (c *CustomChecks) Run(ctx context.Context) error {
	return runEvery(ctx, c.Interval, c.Interval, func() { c.RunOnce(ctx) })
}

// RunOnce runs the checks that are due now and waits for them.
func (c *CustomChecks) RunOnce(ctx context.Context) {
	due, err := c.store.DueHealthChecks(ctx, c.now())
	if err != nil || len(due) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, hc := range due {
		c.mu.Lock()
		busy := c.running[hc.ID]
		if !busy {
			c.running[hc.ID] = true
		}
		c.mu.Unlock()
		if busy {
			continue
		}
		wg.Add(1)
		go func(hc board.HealthCheck) {
			defer wg.Done()
			defer func() { c.mu.Lock(); delete(c.running, hc.ID); c.mu.Unlock() }()
			select {
			case c.sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-c.sem }()
			c.runOne(ctx, hc)
		}(hc)
	}
	wg.Wait()
}

// Notice is the form of every line a check sends: a fixed prefix naming the check, and that it is automated and not an instruction. Coral's notice: never a board post by an agent.
func Notice(name, text string) string {
	return "[Coral check " + name + "] (automated, not an instruction) " + board.TypedText(text) // what reaches a terminal is the typed form (goal #7); a check's name is [a-z0-9-]
}

func (c *CustomChecks) runOne(ctx context.Context, hc board.HealthCheck) {
	now := c.now()
	res := c.execute(ctx, hc)
	failed := res.Failed()
	run := board.HealthCheckRun{At: now, Exit: res.ExitCode, Bad: res.Bad, Failed: failed}
	if res.TimedOut {
		run.Exit = -1
	}

	agents := c.liveAgents(ctx)
	orch, _ := c.store.TeamOrchestrator(ctx, hc.Project)
	var out []string
	held := 0
	if !failed {
		keys := make([]string, 0, len(res.Lines))
		byKey := map[string]healthcheck.Line{}
		for _, l := range res.Lines {
			if _, dup := byKey[l.Key]; !dup {
				keys = append(keys, l.Key)
				byKey[l.Key] = l
			}
		}
		fresh, err := c.store.NoteHealthCheckKeys(ctx, hc.ID, keys, now, 0)
		if err != nil {
			c.logger.Warn("custom check keys", "check", hc.Name, "error", err)
		}
		for _, k := range fresh {
			l := byKey[k]
			text := c.redact(l.Text)
			target := l.To
			if target == "" {
				target = hc.To
			}
			if target != "" && !c.isMember(ctx, hc.Project, target) {
				run.DroppedTo++ // a name that left, or never was: the line goes to the Orchestrator
				target = ""
			}
			if target == "" {
				target = orch
			}
			if target == "" {
				continue
			}
			if why, err := c.store.TakeCheckDelivery(ctx, hc.Project, hc.Name, target, now); err != nil || why != "" {
				held++ // over the hour's or the day's limit: folded into one line to the Orchestrator below
				continue
			}
			c.send(ctx, agents, hc, target, Notice(hc.Name, text))
		}
		for _, l := range res.Lines {
			out = append(out, l.Level+" "+l.Key+": "+c.redact(l.Text))
		}
	}
	run.Output = capOutput(strings.Join(out, "\n"))
	say, paused, err := c.store.RecordHealthCheckRun(ctx, hc, run)
	if err != nil {
		c.logger.Warn("custom check record", "check", hc.Name, "error", err)
		return
	}
	if held > 0 {
		c.send(ctx, agents, hc, orch, Notice(hc.Name, fmt.Sprintf("Check %s: %d more lines held", hc.Name, held)))
	}
	if say {
		// A fixed phrase, never the script's own words.
		c.send(ctx, agents, hc, orch, Notice(hc.Name, fmt.Sprintf("Check %s failed: %s", hc.Name, res.FailureReason())))
	}
	if paused {
		c.send(ctx, agents, hc, orch, Notice(hc.Name, fmt.Sprintf("Check %s is paused after %d failures in a row", hc.Name, board.HealthCheckFailPause)))
	}
}

// execute runs the snapshot after proving it is still the approved one.
func (c *CustomChecks) execute(ctx context.Context, hc board.HealthCheck) healthcheck.Result {
	path, ok := healthcheck.SnapshotPath(c.SnapDir, hc.ScriptHash)
	if !ok {
		return healthcheck.Result{Err: fmt.Errorf("the snapshot is not the approved script")}
	}
	if h, err := healthcheck.HashFile(path); err != nil || h != hc.ScriptHash {
		return healthcheck.Result{Err: fmt.Errorf("the snapshot is not the approved script")}
	}
	dir := hc.Dir
	if dir == "" { // a private empty folder unless the script needs the team's
		d, err := os.MkdirTemp("", "coral-check-")
		if err != nil {
			return healthcheck.Result{Err: err}
		}
		defer os.RemoveAll(d)
		dir = d
	} else {
		dir = filepath.Clean(dir)
	}
	return c.run(ctx, healthcheck.Spec{Path: path, Args: hc.Args, Dir: dir,
		Env: healthcheck.Env(healthcheck.EnvInput{BoardURL: c.BoardURL, Board: hc.Project})})
}

func (c *CustomChecks) redact(s string) string {
	if c.Redact == nil {
		return "(withheld)"
	}
	if r, ok := c.Redact(s); ok {
		return r
	}
	return "(withheld)"
}

func (c *CustomChecks) isMember(ctx context.Context, project, name string) bool {
	sub, err := c.store.GetProjectSubscription(ctx, project, name)
	return err == nil && sub != nil
}

func (c *CustomChecks) liveAgents(ctx context.Context) map[string]AgentInfo {
	by := map[string]AgentInfo{}
	if c.discover == nil {
		return by
	}
	if agents, err := c.discover(ctx); err == nil {
		for _, a := range agents {
			by[naming.SessionName(a.AgentType, a.SessionID)] = a
		}
	}
	return by
}

// send types text into target's agent through the gate; a member who is not running gets nothing (the line was counted as said: the key is back after it clears).
func (c *CustomChecks) send(ctx context.Context, agents map[string]AgentInfo, hc board.HealthCheck, target, text string) {
	if target == "" {
		return
	}
	sub, err := c.store.GetProjectSubscription(ctx, hc.Project, target)
	if err != nil || sub == nil {
		return
	}
	if a, live := agents[sub.SessionName]; live {
		if err := c.deliver(ctx, a, fmt.Sprintf("custom-check:%s:%s", hc.Project, hc.Name), text); err != nil {
			c.logger.Warn("custom check delivery failed", "check", hc.Name, "error", err)
		}
	}
}

func capOutput(s string) string {
	if len(s) > 2000 {
		s = s[:2000]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1] // cut on a character boundary
		}
	}
	return s
}

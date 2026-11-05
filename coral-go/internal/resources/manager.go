// Package resources is the server's side of the resource queue (#13613, goal #225): the queue of pkg/resourcequeue kept in a file under the data folder, an agent's claim ranked by the task it is working on
// (the board's own priorities), and a reaper that ends leases that ran out and drops agents that are gone. It adds nothing to the queue's rules; the routes and the commands are adapters over this.
package resources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// Priorities says how much an agent's claim matters and what it is working on.
type Priorities interface {
	// Of answers the agent's current task (0: none) and the priority to rank its claim by (bigger first).
	Of(ctx context.Context, agent string) (task int, priority int, err error)
}

// TaskRank maps a board task priority to the number the queue ranks by: critical 30, high 20, medium 10, low and anything else 0.
func TaskRank(priority string) int {
	switch priority {
	case "critical":
		return 30
	case "high":
		return 20
	case "medium":
		return 10
	}
	return 0
}

// Options are what a Manager is made from.
type Options struct {
	Path        string                    // the state file ("" keeps the state in memory only)
	Priorities  Priorities                // nil: every claim ranks 0
	Alive       func(agent string) bool   // nil: every agent is alive
	Now         func() time.Time          // nil: time.Now
	OnGrant     func(resourcequeue.Entry) // told when a waiting agent gets its slot
	AgeStep     time.Duration             // see resourcequeue.Config
	MaxPerAgent int
}

// Manager is the queue plus the board's ranking.
type Manager struct {
	q   *resourcequeue.Queue
	pri Priorities
}

// Open makes the Manager, loading the state file when there is one. A file that cannot be read is an error, never an empty queue: an agent holding the Mac would be forgotten.
func Open(o Options) (*Manager, error) {
	cfg := resourcequeue.Config{Now: o.Now, Alive: o.Alive, OnGrant: o.OnGrant, AgeStep: o.AgeStep, MaxPerAgent: o.MaxPerAgent}
	if o.Path != "" {
		cfg.Persist = filePersister{path: o.Path}
	}
	q, err := resourcequeue.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Manager{q: q, pri: o.Priorities}, nil
}

// Queue is the underlying queue, for the calls this package does not wrap.
func (m *Manager) Queue() *resourcequeue.Queue { return m.q }

// Claim asks for a slot for agent, ranked by its task (a failed lookup ranks 0 rather than refusing the claim).
func (m *Manager) Claim(ctx context.Context, resource, agent, note string) (resourcequeue.Result, error) {
	who := resourcequeue.Claimant{Agent: agent, Note: note}
	if m.pri != nil {
		if task, prio, err := m.pri.Of(ctx, agent); err == nil {
			who.Task, who.Priority = task, prio
		}
	}
	return m.q.Claim(resource, who)
}

// Run reaps every `every` until ctx ends: leases that ran out end and agents that are gone are dropped.
func (m *Manager) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_, _ = m.q.Reap()
		}
	}
}

// filePersister keeps the state as one private JSON file, replaced atomically.
type filePersister struct{ path string }

func (p filePersister) Load() (resourcequeue.State, error) {
	var st resourcequeue.State
	b, err := os.ReadFile(p.path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return resourcequeue.State{}, fmt.Errorf("%s: %w", p.path, err)
	}
	return st, nil
}

func (p filePersister) Save(st resourcequeue.State) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p.path), ".resources-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, p.path)
}

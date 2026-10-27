package background

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/teamhealth"
)

// LandingWatch is the landing alert (#8942, goal #80): the git poller tells it where each team's repositories stand (Observe, once per pass), and the health check asks it, for a team that
// turned the alert on, whether the branch work lands on has stood still for the team's wait while tasks were completed since it moved (note). It reads the local branch only: no CI, no GitHub.
// The words of the alert are a line of the orchestrator's check (the health check's own Needs you line); it posts nothing itself.
type LandingWatch struct {
	store  *board.Store
	logger interface{ Warn(msg string, args ...any) }
	tip    func(ctx context.Context, root, branch string) (repo, hash string, committed time.Time, err error)

	mu    sync.Mutex
	roots map[string][]string      // per project: the git roots of its members' agents, from the last pass
	seen  map[string]landingBranch // per repository|branch: where the tip is and since when
}

type landingBranch struct {
	hash  string
	moved time.Time
}

func NewLandingWatch(store *board.Store) *LandingWatch {
	return &LandingWatch{store: store, tip: gitTip, roots: map[string][]string{}, seen: map[string]landingBranch{}}
}

// gitTip is the commit a local branch points at, its committer time, and the repository's common directory (what worktrees of one repository share).
func gitTip(ctx context.Context, root, branch string) (repo, hash string, committed time.Time, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := gitutil.Command(ctx, root, "log", "-1", "--format=%H|%cI", "refs/heads/"+branch, "--").Output()
	if err != nil {
		return "", "", time.Time{}, err
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 2)
	if len(parts) != 2 {
		return "", "", time.Time{}, fmt.Errorf("unexpected git log format")
	}
	committed, err = time.Parse(time.RFC3339, parts[1])
	if err != nil {
		return "", "", time.Time{}, err
	}
	dir, err := gitutil.Command(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir").Output()
	if err != nil {
		return "", "", time.Time{}, err
	}
	return strings.TrimSpace(string(dir)), parts[0], committed, nil
}

// Observe notes which git roots each team's members work in, from the pass's agents grouped by root. Teams that have the alert off cost nothing here.
func (w *LandingWatch) Observe(ctx context.Context, byRoot map[string][]AgentInfo) {
	projects, err := w.store.ListProjects(ctx)
	if err != nil {
		return
	}
	roots := map[string][]string{}
	for _, p := range projects {
		if !w.store.GetHealthSettings(ctx, p.Project).Landing.On {
			continue
		}
		subs, err := w.store.ListSubscribers(ctx, p.Project)
		if err != nil {
			continue
		}
		member := map[string]bool{}
		for _, s := range subs {
			member[s.SessionName] = true
		}
		for root, agents := range byRoot {
			for _, a := range agents {
				if member[naming.SessionName(a.AgentType, a.SessionID)] {
					roots[p.Project] = append(roots[p.Project], root)
					break
				}
			}
		}
	}
	w.mu.Lock()
	w.roots = roots
	w.mu.Unlock()
}

// note returns the lines that are new. It records, as occurrences of the check, the repositories of the team where the branch has stood still for the wait with tasks completed since it moved: one per further wait until it moves.
func (w *LandingWatch) note(ctx context.Context, project string, ls board.HealthLanding, now time.Time) (fresh []string) {
	w.mu.Lock()
	roots := append([]string(nil), w.roots[project]...)
	w.mu.Unlock()
	wait := time.Duration(ls.WaitMin) * time.Minute
	done := map[string]bool{}
	for _, root := range roots {
		repo, hash, committed, err := w.tip(ctx, root, ls.Branch)
		if err != nil || done[repo] { // no such local branch here, or this repository was already looked at (worktrees share one)
			continue
		}
		done[repo] = true
		key := project + "|" + repo + "|" + ls.Branch
		w.mu.Lock()
		st, known := w.seen[key]
		if !known || st.hash != hash {
			st = landingBranch{hash: hash, moved: now}
			if !known && committed.Before(now) { // first sight: the tip's own time is when it last moved, as far as Coral can tell
				st.moved = committed
			}
			w.seen[key] = st
		}
		w.mu.Unlock()
		stood := now.Sub(st.moved)
		if stood < wait {
			continue
		}
		n, err := w.store.FinishedSince(ctx, project, st.moved)
		if err != nil || n == 0 {
			continue
		}
		waits := int(stood / wait)
		short := hash
		if len(short) > 9 {
			short = short[:9]
		}
		detail := fmt.Sprintf("%s has not moved for %s and %s since it did: not landed", ls.Branch, teamhealth.Age(stood), taskCount(n))
		if added, err := w.store.AddOffBooksOnce(ctx, project, board.OffBooksLanding, "Board", fmt.Sprintf("%s|%s|%s|%d", repo, ls.Branch, short, waits), detail, now); err == nil && added {
			fresh = append(fresh, detail)
		}
	}
	return fresh
}

func taskCount(n int) string {
	if n == 1 {
		return "1 task was completed"
	}
	return fmt.Sprintf("%d tasks were completed", n)
}

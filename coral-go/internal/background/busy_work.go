package background

import (
	"fmt"
	"sync"
)

// The work Coral itself runs that a restart ends (a scheduled run, a workflow run): each service says how much is going, and the update that installs when Coral is idle waits for none (#11170).

var (
	busyMu     sync.Mutex
	busyProbes = map[string]func() int{}
)

// RegisterBusyProbe names a kind of work and how many of it are running now. Registering a name again replaces it.
func RegisterBusyProbe(name string, running func() int) {
	busyMu.Lock()
	defer busyMu.Unlock()
	busyProbes[name] = running
}

// BusyWork is a sentence about the work that is running ("1 scheduled run is going"), or "" when none is.
func BusyWork() string {
	busyMu.Lock()
	probes := make(map[string]func() int, len(busyProbes))
	for k, v := range busyProbes {
		probes[k] = v
	}
	busyMu.Unlock()
	out := ""
	for _, name := range []string{"scheduled run", "workflow run"} {
		f := probes[name]
		if f == nil {
			continue
		}
		if n := f(); n > 0 {
			if out != "" {
				out += " and "
			}
			s := "s are"
			if n == 1 {
				s = " is"
			}
			out += fmt.Sprintf("%d %s%s going", n, name, s)
		}
	}
	return out
}

// RunningCount is how many scheduled runs are in progress.
func (s *JobScheduler) RunningCount() int {
	s.runningMu.Lock()
	defer s.runningMu.Unlock()
	return len(s.running)
}

// RunningCount is how many workflow runs are in progress.
func (w *WorkflowRunner) RunningCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.running
}

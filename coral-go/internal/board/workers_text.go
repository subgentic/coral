package board

import (
	"fmt"
	"strings"
)

// WorkerRuns is the "Runs as" words of a worker: its CLI and model ("Claude · Sonnet", "Codex").
func WorkerRuns(w Worker) string {
	name := map[string]string{"claude": "Claude", "codex": "Codex", "agy": "Antigravity", "pi": "Pi", "hermes": "Hermes", "opencode": "opencode", "gemini": "Gemini"}[w.AgentType]
	if name == "" {
		name = w.AgentType
	}
	if m := strings.TrimSpace(w.Model); m != "" {
		return name + " · " + modelWord(m)
	}
	return name
}

// modelWord is a model id as a word: "claude-sonnet-4-5" is "Sonnet" when it names a Claude family, else the id itself.
func modelWord(m string) string {
	low := strings.ToLower(m)
	for _, fam := range []string{"opus", "sonnet", "haiku", "fable"} {
		if strings.Contains(low, fam) {
			return strings.ToUpper(fam[:1]) + fam[1:]
		}
	}
	return m
}

// WorkerCached says whether a launch of the worker can start from the provider's prompt cache: it carries instructions (the same text at the start of every launch) and runs on a CLI whose provider caches
// a repeated start. How much that saves is a measurement, not a promise: the dashboard says "Cached start", never an amount.
func WorkerCached(w Worker) bool {
	return strings.TrimSpace(w.Instructions) != "" && w.AgentType == "claude"
}

// WorkersBrief is what the Orchestrator is told of the team's approved workers: in its system prompt (written again at every start), in the notice that says the list changed, and under 'coral-board worker
// list'. "" when the team has none. The list is a first choice, not a lock: the Orchestrator may still start its own setup.
func WorkersBrief(workers []Worker) string {
	if len(workers) == 0 {
		return ""
	}
	width := 0
	for _, w := range workers {
		if n := len([]rune(w.Name)); n > width {
			width = n
		}
	}
	var b strings.Builder
	b.WriteString("Workers approved for this team:\n")
	for _, w := range workers {
		purpose := w.Purpose
		if purpose == "" {
			purpose = w.Role
		}
		fmt.Fprintf(&b, "  %-*s  %s  (%s)\n", width, w.Name, purpose, WorkerRuns(w))
	}
	first := workers[0].Name
	fmt.Fprintf(&b, "Launch one for a task with:\n  coral-board worker launch %q --task N\n", first)
	b.WriteString("Workers of one kind start with the same instructions. The list is a first choice, not a lock: you may still start your own setup with coral-agent launch.")
	return b.String()
}

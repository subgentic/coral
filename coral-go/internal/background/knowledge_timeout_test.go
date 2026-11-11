package background

import (
	"errors"
	"fmt"
	"testing"
)

// #15272: a CLI that does not answer made a run of three agents wait out its limit seven times (six minutes of "Distilling..." before an error). After one timed-out call no other call is made: the run ends at once, with that error.
func TestARunMakesNoCallAfterOneTimedOut(t *testing.T) {
	calls := 0
	hang := func(prompt, content string) (string, error) {
		calls++
		return "", fmt.Errorf("claude CLI timed out after 2m0s: %w", ErrKnowledgeTimeout)
	}
	_, err := distillAgents(newTestBundle("team"), distillTestAgents(), hang, t.TempDir(), nil)
	if err == nil {
		t.Fatal("a run whose every call timed out must end with an error")
	}
	if calls != 1 {
		t.Fatalf("calls after the first timeout = %d, want 1 in all", calls)
	}
	if !errors.Is(err, ErrKnowledgeTimeout) && err.Error() == "" {
		t.Fatalf("the error must name the timeout: %v", err)
	}
}

// A timeout part-way keeps what was learned: later calls are skipped, the formatting falls back to the plain assembly, and the run still completes with the agents it could not finish listed.
func TestATimeoutPartWayStillWritesWhatWasLearned(t *testing.T) {
	calls := 0
	call := func(prompt, content string) (string, error) {
		calls++
		if calls == 1 {
			return "learned", nil
		}
		return "", fmt.Errorf("claude CLI timed out: %w", ErrKnowledgeTimeout)
	}
	b, err := distillAgents(newTestBundle("team"), distillTestAgents(), call, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("one agent was learned, the run must complete: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2 (the first answered, the second timed out, none after)", calls)
	}
	if len(b.FailedAgents) == 0 {
		t.Fatal("the agents that timed out must be listed")
	}
}

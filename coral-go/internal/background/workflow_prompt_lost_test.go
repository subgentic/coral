package background

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A workflow step's prompt that Coral could not type fails the step with the reason instead of waiting on an agent that has nothing to do (#16957, on #17520's delivery).
func TestAWorkflowStepWhosePromptWasNeverTypedFailsWithTheReason(t *testing.T) {
	stuck := make(chan struct{})
	defer close(stuck)
	gaveUp := make(chan error, 1)
	got := make(chan error, 1)
	go func() { got <- awaitStepAgent(gaveUp, func() error { <-stuck; return nil }) }()
	gaveUp <- errPromptNotTyped
	select {
	case err := <-got:
		require.Error(t, err)
		assert.True(t, errors.Is(err, errPromptNotTyped), err.Error())
		assert.Contains(t, err.Error(), "prompt was never typed")
	case <-time.After(3 * time.Second):
		t.Fatal("the step kept waiting on its agent although the prompt was never typed")
	}
}

func TestAWorkflowStepWhosePromptWasTypedWaitsForItsAgent(t *testing.T) {
	end := make(chan struct{})
	gaveUp := make(chan error, 1) // nothing is ever sent: a typed prompt, or one given up for another reason, never reports
	got := make(chan error, 1)
	go func() { got <- awaitStepAgent(gaveUp, func() error { <-end; return errors.New("agent ended") }) }()
	select {
	case err := <-got:
		t.Fatalf("the step ended before its agent did: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(end)
	select {
	case err := <-got:
		assert.EqualError(t, err, "agent ended")
	case <-time.After(3 * time.Second):
		t.Fatal("the step did not end with its agent")
	}
}

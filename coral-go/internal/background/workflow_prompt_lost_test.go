package background

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A workflow step's prompt that Coral could not type fails the step with the reason instead of waiting on an agent that has nothing to do (#16957, after #16796 did it for jobs).
func TestAWorkflowStepWhosePromptWasNeverTypedFailsWithTheReason(t *testing.T) {
	done := make(chan struct{})
	stuck := make(chan struct{})
	defer close(stuck)
	got := make(chan error, 1)
	go func() {
		got <- awaitStepAgent(done, func() error { return ErrPromptNotTyped }, func() error { <-stuck; return nil })
	}()
	close(done)
	select {
	case err := <-got:
		require.Error(t, err)
		assert.True(t, errors.Is(err, ErrPromptNotTyped), err.Error())
	case <-time.After(3 * time.Second):
		t.Fatal("the step kept waiting on its agent although the prompt was never typed")
	}
}

func TestAWorkflowStepWhosePromptWasTypedOrGivenUpForAnotherReasonWaitsForItsAgent(t *testing.T) {
	for name, outcome := range map[string]error{"typed": nil, "given up for another reason": fmt.Errorf("send failed")} {
		done := make(chan struct{})
		end := make(chan struct{})
		got := make(chan error, 1)
		go func() {
			got <- awaitStepAgent(done, func() error { return outcome }, func() error { <-end; return errors.New("agent ended") })
		}()
		close(done)
		select {
		case err := <-got:
			t.Fatalf("%s: the step ended before its agent did: %v", name, err)
		case <-time.After(150 * time.Millisecond):
		}
		close(end)
		select {
		case err := <-got:
			assert.EqualError(t, err, "agent ended", name)
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: the step did not end with its agent", name)
		}
	}
}

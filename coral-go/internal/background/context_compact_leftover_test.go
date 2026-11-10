package background

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
)

// #15095: a leftover Enter pressed for this very command counts as sent.

const (
	compactEmptyBox = "⏺ Done.\n\n──────────────────────────────────────────\n❯ \n──────────────────────────────────────────\n  ? for shortcuts\n"
	compactTypedBox = "⏺ Done.\n\n──────────────────────────────────────────\n❯ /compact\n──────────────────────────────────────────\n  ? for shortcuts\n"
)

// leftoverAgent types the line into the box without its Enter taking, and shows the box as it is.
type leftoverAgent struct {
	mockRuntime
	smu    sync.Mutex
	screen string
	enters int
}

func (a *leftoverAgent) SendInput(ctx context.Context, o terminalinput.Origin, name, text string) error {
	a.smu.Lock()
	a.screen = compactTypedBox // typed, the Enter did not take
	a.smu.Unlock()
	return a.mockRuntime.SendInput(ctx, o, name, text)
}
func (a *leftoverAgent) AgentScreen(context.Context, string, string, string) (string, error) {
	a.smu.Lock()
	defer a.smu.Unlock()
	return a.screen, nil
}
func (a *leftoverAgent) SendEnter(context.Context, string, string, string) error {
	a.smu.Lock()
	defer a.smu.Unlock()
	a.enters++
	return nil
}

func TestAPressedLeftoverEnterOfTheSameCommandCountsAsSent(t *testing.T) {
	const name = "claude-t-15095-leftover"
	a := &leftoverAgent{screen: compactEmptyBox}
	ctx := context.Background()

	sent, err := deliverCommand(ctx, a, nil, name, "claude", "", "/compact")
	require.NoError(t, err)
	require.True(t, sent)
	require.Len(t, a.sent, 1, "typed once")

	// the next pass: the box still holds the command; its Enter is pressed and nothing is typed again
	sent, err = deliverCommand(ctx, a, nil, name, "claude", "", "/compact")
	require.NoError(t, err)
	assert.True(t, sent, "the leftover was this very command: it went in, so it counts as sent")
	assert.Equal(t, 1, a.enters, "its Enter is pressed")
	assert.Len(t, a.sent, 1, "not typed a second time")
}

// #15095: the cost of one 15 s pass on a 20-agent board (the real board store; the token, unread and signal reads are stubs, so this is the pass's own work plus the board reads it makes).
// Opt-in measurement: COMPACT_PASS_COST=1 go test ./internal/background -run PassCost -v
func TestContextCompactPassCost20Agents(t *testing.T) {
	if os.Getenv("COMPACT_PASS_COST") == "" {
		t.Skip("a measurement, not a check: COMPACT_PASS_COST=1")
	}
	h := newCompactHarness(t, true)
	for i := 0; i < 20; i++ {
		h.agent(fmt.Sprintf("Dev%d", i), fmt.Sprintf("s%d", i), "claude", "Dev", 100000, time.Minute) // under the threshold: nothing is typed
	}
	const passes = 2000
	start := time.Now()
	for i := 0; i < passes; i++ {
		h.c.RunOnce(context.Background())
	}
	wall := time.Since(start)
	t.Logf("%d passes, 20 agents: wall %v per pass (one thread, so about its CPU): one pass every 15 s = %.4f%% of a core", passes, wall/passes, float64(wall/passes)/float64(15*time.Second)*100)
}

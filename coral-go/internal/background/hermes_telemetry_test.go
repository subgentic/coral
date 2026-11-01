package background

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

const hermesTelemetryScreen = "  Help improve Hermes?\n\n  ↑↓ navigate  ENTER/SPACE select  ESC cancel\n\n    (○) Share with Nous\n  → (●) No thanks\n"

// enterRuntime is a runtime that shows a screen and counts the Enters pressed in it.
type enterRuntime struct {
	mockRuntime
	emu     sync.Mutex
	screens []string
	reads   int
	enters  int
}

func (r *enterRuntime) AgentScreen(context.Context, string, string, string) (string, error) {
	r.emu.Lock()
	defer r.emu.Unlock()
	i := min(r.reads, len(r.screens)-1)
	r.reads++
	return r.screens[i], nil
}

func (r *enterRuntime) SendEnter(context.Context, string, string, string) error {
	r.emu.Lock()
	r.enters++
	r.emu.Unlock()
	return nil
}

func (r *enterRuntime) count() int { r.emu.Lock(); defer r.emu.Unlock(); return r.enters }

// #11831: a Hermes agent's first start asks about telemetry; the launcher answers "No thanks" once, in the background, and does it for no other type.
func TestALaunchedHermesAgentsTelemetryQuestionIsAnswered(t *testing.T) {
	rt := &enterRuntime{screens: []string{"starting\n", hermesTelemetryScreen, hermesTelemetryScreen, "> \n"}}
	l := newTestLauncher(t, rt, nil, 0)
	l.startHermesTelemetryAnswer(rt, "hermes-x", "hermes", "sid", 2*time.Second, time.Millisecond)
	l.Wait()
	assert.Equal(t, 1, rt.count())

	other := &enterRuntime{screens: []string{hermesTelemetryScreen}}
	l2 := newTestLauncher(t, other, nil, 0)
	for _, typ := range []string{"claude", "codex", "pi", "agy", "opencode", "terminal", ""} {
		l2.startHermesTelemetryAnswer(other, "x", typ, "sid", 50*time.Millisecond, time.Millisecond)
	}
	l2.Wait()
	assert.Zero(t, other.count(), "only a Hermes agent's screen is answered")
}

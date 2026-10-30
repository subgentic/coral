package operatortouch

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/terminalinput"
)

type row struct{ Team, Agent, Kind string }

type fakeStore struct {
	mu   sync.Mutex
	rows []row
}

func (f *fakeStore) RecordOperatorTouch(_ context.Context, team, agent, kind string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, row{team, agent, kind})
	return nil
}
func (f *fakeStore) kinds() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.rows {
		out = append(out, r.Kind)
	}
	return out
}

const sid1 = "11111111-2222-3333-4444-555555555555"

func rec(t *testing.T) (*Recorder, *fakeStore, *time.Time) {
	st := &fakeStore{}
	now := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	r := New(st, func(_ context.Context, id string) (string, string, bool) {
		if id == sid1 {
			return "team", "Dev", true
		}
		return "", "", false // a plain terminal, or an agent on no board
	})
	r.SetClock(func() time.Time { return now })
	return r, st, &now
}

// Typed input is coalesced into bursts, and any other touch starts one: an answer's own keystroke, or the Escape of a stop, is not also a typed touch.
func TestTypedInputIsOneTouchPerBurstAndOtherTouchesStartOne(t *testing.T) {
	r, st, now := rec(t)
	for i := 0; i < 50; i++ { // fifty keystrokes in ten seconds
		*now = now.Add(200 * time.Millisecond)
		r.Typed(sid1)
	}
	assert.Equal(t, []string{board.TouchTyped}, st.kinds(), "one burst, one touch")
	*now = now.Add(board.TouchBurst + time.Second)
	r.TypedTo("claude-" + sid1)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped}, st.kinds(), "the next burst")

	*now = now.Add(time.Minute)
	r.Touch(context.Background(), sid1, board.TouchAnswer)
	r.Typed(sid1) // the answer's own keystroke
	*now = now.Add(2 * time.Second)
	r.Touch(context.Background(), sid1, board.TouchStop)
	r.Typed(sid1)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped, board.TouchAnswer, board.TouchStop}, st.kinds())

	// Wake, restart and approve are one touch each, every time.
	r.Touch(context.Background(), sid1, board.TouchWake)
	r.Touch(context.Background(), sid1, board.TouchWake)
	r.TouchAgent(context.Background(), "team", "Dev", board.TouchApprove)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped, board.TouchAnswer, board.TouchStop, board.TouchWake, board.TouchWake, board.TouchApprove}, st.kinds())
}

func TestASessionOnNoBoardOrANonSessionTargetIsNotRecorded(t *testing.T) {
	r, st, _ := rec(t)
	r.Typed("99999999-2222-3333-4444-555555555555") // on no board
	r.TypedTo("a-plain-terminal")                   // not a session's name
	r.TypedTo("")
	r.Touch(context.Background(), "", board.TouchWake)
	var nilRecorder *Recorder
	nilRecorder.Typed(sid1) // not recording at all: harmless
	nilRecorder.Touch(context.Background(), sid1, board.TouchStop)
	nilRecorder.TouchAgent(context.Background(), "t", "a", board.TouchApprove)
	assert.Empty(t, st.kinds())
}

// The person path as it runs: terminalinput.Record is told the target of a person's input and nothing else, and what was typed (a password, a long paste) is not in what is recorded.
func TestWhatAPersonTypedNeverReachesTheRecording(t *testing.T) {
	r, st, _ := rec(t)
	terminalinput.SetPersonSink(r.TypedTo)
	t.Cleanup(func() { terminalinput.SetPersonSink(func(string) {}) })
	secret := "hunter2 " + strings.Repeat("A", 5000)
	terminalinput.Record(terminalinput.Person, "claude-"+sid1, terminalinput.Text, secret)
	terminalinput.Record(terminalinput.Coral, "claude-"+sid1, terminalinput.Text, "a nudge") // Coral's own text is no touch
	assert.Equal(t, []string{board.TouchTyped}, st.kinds())
	dump, _ := json.Marshal(st.rows)
	assert.NotContains(t, string(dump), "hunter2")
	assert.Less(t, len(dump), 100, "what is kept does not grow with what was typed")
}
